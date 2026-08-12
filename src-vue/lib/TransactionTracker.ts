import {
  type ArgonClient,
  ExtrinsicError,
  type GenericEvent,
  hexToU8a,
  isOutdatedTransactionError,
  ISubmittableOptions,
  type ISubmittableResult,
  SignedBlock,
  SubmittableExtrinsic,
  type TxSigningAccount,
  TxResult,
  TxSubmissionError,
  TxSubmissionErrorCode,
} from '@argonprotocol/mainchain';
import * as Vue from 'vue';
import { Db } from './Db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { BlockWatch, createDeferred, IBlockHeaderInfo, IDeferred, TransactionEvents } from '@argonprotocol/apps-core';
import { ExtrinsicType, ITransactionRecord, TransactionsTable, TransactionStatus } from './db/TransactionsTable.ts';
import { LRU } from 'tiny-lru';
import { TransactionInfo } from './TransactionInfo.ts';
import {
  type ITransactionStatusHistoryRecord,
  TransactionHistorySource,
  TransactionHistoryStatus,
  type TransactionStatusHistoryTable,
} from './db/TransactionStatusHistoryTable.ts';

type IWatchedTxStatus = {
  isBroadcast: boolean;
  isInBlock: boolean;
  isFinalized: boolean;
  isRetracted: boolean;
  isUsurped: boolean;
  isDropped: boolean;
  isInvalid: boolean;
  blockHash?: string;
  blockNumber?: number;
  replacementTxHash?: string;
};

export enum TxAttemptState {
  Pending = 'Pending',
  Finalized = 'Finalized',
  Replace = 'Replace',
}

enum TxReconciliationState {
  Included = 'Included',
  InPool = 'InPool',
  Absent = 'Absent',
  Unavailable = 'Unavailable',
}

export class TransactionTracker {
  public data: {
    txInfos: TransactionInfo[];
    txInfosByType: Partial<Record<ExtrinsicType, TransactionInfo>>;
  };

  #waitForLoad?: IDeferred;
  #table?: TransactionsTable;
  #historyTable?: TransactionStatusHistoryTable;
  #latestHistoryByTxId = new Map<number, ITransactionStatusHistoryRecord>();
  #blockCache = new LRU<SignedBlock>(25);
  #bestBlockNumber?: number;
  #watchUnsubscribe?: () => void;
  #nonceLaneByAddress = new Map<string, Promise<void>>();
  #statusLaneByTxId = new Map<number, Promise<void>>();
  #pendingWatchResultsByTxId = new Map<number, number>();
  #reconciliationByTxId = new Map<number, { head: string; state: TxReconciliationState }>();
  #isClosed = false;

  constructor(
    private readonly dbPromise: Promise<Db>,
    private blockWatch: BlockWatch,
  ) {
    this.data = {
      txInfos: [],
      txInfosByType: {},
    };
  }

  public get pendingBlockTxInfosAtLoad(): TransactionInfo<any>[] {
    return this.data.txInfos.filter(x => this.isPendingTxInfoAtLoad(x));
  }

  public async load(reload = false): Promise<void> {
    this.#isClosed = false;
    if (this.#waitForLoad?.isRunning) return this.#waitForLoad.promise;
    if (!reload && this.#waitForLoad?.isResolved) return this.#waitForLoad.promise;

    if (reload || this.#waitForLoad?.isRejected) {
      this.#waitForLoad = createDeferred();
    } else {
      this.#waitForLoad ??= createDeferred();
    }
    try {
      const table = await this.getTable();
      const txs = await table.fetchAll();
      this.#latestHistoryByTxId = await this.getHistoryTable().then(x =>
        x.fetchLatestByTransactionIds(txs.map(y => y.id)),
      );
      const client = await getMainchainClient(false);
      await this.blockWatch.start();

      this.#reconciliationByTxId.clear();
      this.data.txInfos.length = 0;
      for (const extrinsicType of Object.keys(this.data.txInfosByType)) {
        delete this.data.txInfosByType[extrinsicType as ExtrinsicType];
      }
      for (const tx of txs) {
        const txResult = new TxResult(client, {
          accountAddress: tx.accountAddress,
          method: tx.extrinsicMethodJson,
          nonce: tx.txNonce ?? 0,
          signedHash: tx.extrinsicHash,
          submittedTime: tx.submittedAtTime,
          submittedAtBlockNumber: tx.submittedAtBlockHeight,
        });
        txResult.isBroadcast = true;
        if (tx.submissionErrorJson) {
          txResult.submissionError = new Error(tx.submissionErrorJson.message);
        }
        txResult.finalFee = tx.txFeePlusTip ?? 0n;
        txResult.finalFeeTip = tx.txTip ?? 0n;
        if (tx.blockHeight) {
          void txResult.setSeenInBlock({
            blockHash: hexToU8a(tx.blockHash),
            blockNumber: tx.blockHeight,
            extrinsicIndex: tx.blockExtrinsicIndex!,
            events: [],
          });
        }
        const txInfo = new TransactionInfo({
          tx,
          txResult,
        });
        if (this.shouldRestoreStoredEventsAtLoad(txInfo)) {
          await this.ensureStoredEvents(txInfo);
        }
        if (tx.blockExtrinsicErrorJson) {
          txResult.extrinsicError = new ExtrinsicError(
            tx.blockExtrinsicErrorJson.errorCode ?? 'Unknown Error',
            tx.blockExtrinsicErrorJson.details ?? tx.blockExtrinsicErrorJson.message,
            tx.blockExtrinsicErrorJson.batchInterruptedIndex,
          );
        }

        if (tx.isFinalized || txResult.submissionError) {
          await txResult.setFinalized();
        }
        // Mark txResult as non-reactive to avoid issues with private fields
        Vue.markRaw(txResult);
        this.data.txInfos.push(txInfo);
        this.data.txInfosByType[tx.extrinsicType] = txInfo;
      }
      for (const txInfo of this.data.txInfos) {
        if (txInfo.tx.followOnTxId) {
          const followOnTx = this.data.txInfos.find(x => x.tx.id === txInfo.tx.followOnTxId);
          if (followOnTx) {
            txInfo.registerDeferredFollowOnTx().resolve(followOnTx);
          }
        }
      }
      if (this.data.txInfos.some(x => this.isTrackedAsPending(x))) {
        await this.watchForUpdates();
      } else {
        this.stopWatching();
      }
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('[TransactionTracker] Error restoring transactions', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async ensureStoredEvents(txInfo: TransactionInfo): Promise<void> {
    if (txInfo.txResult.events.length || !txInfo.tx.blockExtrinsicEventsJson?.length) {
      return;
    }

    const client = await getMainchainClient(false);
    const decodeStoredEvents = ({ registry }: Pick<typeof client, 'registry'>): GenericEvent[] =>
      txInfo.tx.blockExtrinsicEventsJson.map(({ raw }) =>
        registry.createType<GenericEvent>('GenericEvent', hexToU8a(raw)),
      );

    try {
      txInfo.txResult.events = decodeStoredEvents(client);
      return;
    } catch (error) {
      let restoreError = error;
      if (txInfo.tx.blockHash && txInfo.tx.blockHeight != null && this.blockWatch.getApi) {
        try {
          const historicalApi = await this.blockWatch.getApi({
            blockNumber: txInfo.tx.blockHeight,
            blockHash: txInfo.tx.blockHash,
          });
          txInfo.txResult.events = decodeStoredEvents(historicalApi);
          restoreError = undefined;
        } catch (historicalError) {
          restoreError = historicalError;
        }
      }

      if (restoreError) {
        console.error(
          `[TransactionTracker] Error restoring events for transaction #${txInfo.tx.id} (${txInfo.tx.extrinsicType})`,
          restoreError,
        );
      }
    }
  }

  public async submitAndWatch<T>(
    args: {
      client?: ArgonClient;
      tx: SubmittableExtrinsic;
      txSigner: TxSigningAccount;
      extrinsicType: ExtrinsicType;
      metadata?: T;
    } & ISubmittableOptions,
  ): Promise<TransactionInfo<T>> {
    await this.load();
    const txInfo = await this.submitAttempt(args);
    await this.watchForUpdates();

    return txInfo;
  }

  private async submitAttempt<T>(
    args: {
      client?: ArgonClient;
      tx: SubmittableExtrinsic;
      txSigner: TxSigningAccount;
      extrinsicType: ExtrinsicType;
      metadata?: T;
    } & ISubmittableOptions,
    outdatedNonceAttempt = 1,
  ): Promise<TransactionInfo<T>> {
    const { client: providedClient, tx, txSigner, extrinsicType, metadata, useLatestNonce, ...providedOptions } = args;
    const client = providedClient ?? (await getMainchainClient(false));
    console.log('[TransactionTracker] SUBMITTING TRANSACTION', extrinsicType);
    const submittedAtBlockHeight = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
    const shouldRetryLatestNonce = useLatestNonce && providedOptions.nonce === undefined;
    const apiOptions = { ...providedOptions };
    const retryArgs = shouldRetryLatestNonce
      ? {
          ...args,
          client,
          tx: client.tx(tx),
        }
      : undefined;
    let releaseNonceReservation: VoidFunction | undefined;
    if (shouldRetryLatestNonce) {
      const reservation = await this.reserveLatestNonce(client, txSigner.address);
      apiOptions.nonce = reservation.nonce;
      releaseNonceReservation = reservation.release;
    }

    let txInfo: TransactionInfo<T>;

    try {
      const signedTx =
        'signer' in txSigner
          ? await tx.signAsync(txSigner.address, { ...apiOptions, signer: txSigner.signer })
          : await tx.signAsync(txSigner, apiOptions);

      const txResultExtrinsic = {
        signedHash: signedTx.hash.toHex(),
        method: signedTx.method.toHuman(),
        nonce: signedTx.nonce.toNumber(),
        accountAddress: txSigner.address,
        submittedTime: new Date(),
        submittedAtBlockNumber: submittedAtBlockHeight,
      };
      const txResult = new TxResult(client, txResultExtrinsic);
      txInfo = await this.registerTxResult({
        txResult,
        extrinsicType,
        metadata,
      });

      let shouldRetryOutdatedNonce = false;
      try {
        await signedTx.send(result => {
          if (this.#isClosed) {
            return;
          }
          txResult.onSubscriptionResult(result);
          void this.handleWatchedResult(txInfo.tx, txResult, result);
        });
      } catch (error) {
        if (this.#isClosed) {
          return txInfo;
        }
        txResult.submissionError = error as Error;
        await this.recordSubmissionError(txInfo.tx, txResult.submissionError);
        shouldRetryOutdatedNonce =
          retryArgs !== undefined && outdatedNonceAttempt < 3 && isOutdatedTransactionError(error);
      }

      if (shouldRetryOutdatedNonce && retryArgs) {
        releaseNonceReservation?.();
        releaseNonceReservation = undefined;
        return await this.submitAttempt(retryArgs, outdatedNonceAttempt + 1);
      }
    } finally {
      releaseNonceReservation?.();
    }

    return txInfo;
  }

  public shutdown(): void {
    this.#isClosed = true;
    this.stopWatching();
  }

  public createIntentForFollowOnTx<T>(txInfo: TransactionInfo): IDeferred<TransactionInfo<T>> {
    const deferred = txInfo.registerDeferredFollowOnTx<T>();
    void deferred.promise.then(async x => {
      const table = await this.getTable();
      await table.recordFollowOnTxId(txInfo.tx, x.tx.id);
    });

    return deferred;
  }

  public findLatestTxInfo<MetadataType = unknown>(
    matcher: (txInfo: TransactionInfo<MetadataType>) => boolean,
  ): TransactionInfo<MetadataType> | undefined {
    return this.data.txInfos.find(txInfo => matcher(txInfo as TransactionInfo<MetadataType>)) as
      | TransactionInfo<MetadataType>
      | undefined;
  }

  public async findLatestTxAttempt<MetadataType = unknown>(args: {
    extrinsicType: ExtrinsicType | ExtrinsicType[];
    waitForConfirmations: number;
    matches?: (txInfo: TransactionInfo<MetadataType>) => boolean;
  }): Promise<{ txInfo: TransactionInfo<MetadataType>; txAttemptState: TxAttemptState } | undefined> {
    await this.load();

    const extrinsicTypes = Array.isArray(args.extrinsicType) ? args.extrinsicType : [args.extrinsicType];
    const txInfo = this.findLatestTxInfo<MetadataType>(candidate => {
      return extrinsicTypes.includes(candidate.tx.extrinsicType) && (args.matches?.(candidate) ?? true);
    });
    if (!txInfo) return;

    return {
      txInfo,
      txAttemptState: await this.getTxAttemptState(txInfo, args.waitForConfirmations),
    };
  }

  public async getTxAttemptState(txInfo: TransactionInfo, waitForConfirmations: number): Promise<TxAttemptState> {
    return await this.runInTransactionStatusLane(txInfo.tx.id, async () => {
      if (
        txInfo.tx.submissionErrorJson ||
        txInfo.tx.blockExtrinsicErrorJson ||
        txInfo.tx.status === TransactionStatus.Error ||
        txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock
      ) {
        return TxAttemptState.Replace;
      }

      const latestHistoryStatus = this.getLatestHistoryStatus(txInfo.tx.id);
      if (
        latestHistoryStatus === TransactionHistoryStatus.Dropped ||
        latestHistoryStatus === TransactionHistoryStatus.Usurped ||
        latestHistoryStatus === TransactionHistoryStatus.Invalid
      ) {
        return TxAttemptState.Replace;
      }

      if (latestHistoryStatus === TransactionHistoryStatus.Retracted && txInfo.tx.txNonce != null) {
        for (const otherTxInfo of this.data.txInfos) {
          if (otherTxInfo.tx.id === txInfo.tx.id) continue;
          if (otherTxInfo.tx.accountAddress !== txInfo.tx.accountAddress) continue;
          if (otherTxInfo.tx.txNonce == null || otherTxInfo.tx.txNonce < txInfo.tx.txNonce) continue;

          if (otherTxInfo.tx.status === TransactionStatus.Finalized) {
            return TxAttemptState.Replace;
          }

          if (otherTxInfo.tx.status !== TransactionStatus.InBlock) {
            continue;
          }

          const { blockHash, blockHeight } = otherTxInfo.tx;
          if (!blockHash || blockHeight == null) {
            continue;
          }

          const header = await this.blockWatch.getHeader(blockHeight).catch(() => undefined);
          if (header?.blockHash === blockHash) {
            return TxAttemptState.Replace;
          }
        }
      }

      let reconciliationState: TxReconciliationState | undefined;
      if (this.isTrackedAsPending(txInfo)) {
        try {
          reconciliationState = await this.reconcilePendingTransaction({
            txInfo,
            bestBlockInfo: { ...this.blockWatch.bestBlockHeader },
            finalizedBlockHeader: { ...this.blockWatch.finalizedBlockHeader },
            finalizedAccountNonceByAddress: new Map(),
          });
        } catch (error) {
          console.warn('[TransactionTracker] Unable to reconcile transaction before choosing an attempt', {
            transactionId: txInfo.tx.id,
            error,
          });
          return TxAttemptState.Pending;
        }
      }

      if (txInfo.txResult.submissionError || txInfo.txResult.extrinsicError) {
        return TxAttemptState.Replace;
      }
      if (txInfo.tx.status === TransactionStatus.Finalized) {
        return TxAttemptState.Finalized;
      }
      if (
        reconciliationState === TxReconciliationState.Included ||
        reconciliationState === TxReconciliationState.InPool
      ) {
        return TxAttemptState.Pending;
      }

      const finalizedHeight = this.blockWatch.finalizedBlockHeader.blockNumber;
      const attemptHeight = txInfo.tx.blockHeight ?? txInfo.tx.submittedAtBlockHeight;
      if (finalizedHeight - attemptHeight <= waitForConfirmations) {
        return TxAttemptState.Pending;
      }
      if (txInfo.tx.status !== TransactionStatus.Submitted && txInfo.tx.status !== TransactionStatus.InBlock) {
        return TxAttemptState.Replace;
      }
      if (reconciliationState === TxReconciliationState.Unavailable) {
        return TxAttemptState.Pending;
      }

      try {
        if (await this.isInTransactionPool(txInfo.tx.extrinsicHash)) {
          return TxAttemptState.Pending;
        }
      } catch (error) {
        console.warn('[TransactionTracker] Unable to check transaction pool before replacing transaction', {
          transactionId: txInfo.tx.id,
          error,
        });
        return TxAttemptState.Pending;
      }

      try {
        reconciliationState = await this.reconcilePendingTransaction({
          txInfo,
          bestBlockInfo: { ...this.blockWatch.bestBlockHeader },
          finalizedBlockHeader: { ...this.blockWatch.finalizedBlockHeader },
          finalizedAccountNonceByAddress: new Map(),
        });
      } catch (error) {
        console.warn('[TransactionTracker] Unable to reconcile transaction before replacing it', {
          transactionId: txInfo.tx.id,
          error,
        });
        return TxAttemptState.Pending;
      }
      if (
        reconciliationState === TxReconciliationState.Included ||
        reconciliationState === TxReconciliationState.InPool ||
        reconciliationState === TxReconciliationState.Unavailable
      ) {
        return TxAttemptState.Pending;
      }
      if (!this.isTrackedAsPending(txInfo)) {
        return TxAttemptState.Replace;
      }
      if (this.#pendingWatchResultsByTxId.has(txInfo.tx.id)) {
        return TxAttemptState.Pending;
      }

      await this.recordHistoryStatus({
        transactionId: txInfo.tx.id,
        status: TransactionHistoryStatus.Dropped,
        source: TransactionHistorySource.Local,
      });
      return TxAttemptState.Replace;
    });
  }

  public async trackTxResult<T>(
    args: {
      txResult: TxResult;
      extrinsicType: ExtrinsicType;
      metadata?: T;
    } & ISubmittableOptions,
  ): Promise<TransactionInfo<T>> {
    await this.load();
    const txInfo = await this.registerTxResult(args);
    await this.watchForUpdates();

    return txInfo;
  }

  private async registerTxResult<T>(args: {
    txResult: TxResult;
    extrinsicType: ExtrinsicType;
    metadata?: T;
  }): Promise<TransactionInfo<T>> {
    const { txResult, extrinsicType, metadata } = args;
    const table = await this.getTable();
    const txNonce = txResult.extrinsic.nonce;

    const extrinsicHash = txResult.extrinsic.signedHash;
    const record = await table.insert({
      extrinsicHash,
      extrinsicMethodJson: txResult.extrinsic.method,
      metadataJson: metadata ?? {},
      extrinsicType,
      accountAddress: txResult.extrinsic.accountAddress,
      submittedAtBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
      submittedAtTime: txResult.extrinsic.submittedTime,
      txNonce,
    });

    // Mark txResult as non-reactive to avoid issues with private fields
    Vue.markRaw(txResult);
    const txInfo = new TransactionInfo<T>({ tx: record, txResult });
    this.data.txInfos.unshift(txInfo);
    this.data.txInfosByType[extrinsicType] = txInfo;
    if (txResult.submissionError) {
      await this.recordSubmissionError(record, txResult.submissionError);
    }

    return txInfo;
  }

  private async watchForUpdates() {
    this.#bestBlockNumber = this.blockWatch.bestBlockHeader.blockNumber;
    await this.updatePendingStatuses(this.blockWatch.bestBlockHeader);

    this.#watchUnsubscribe ??= this.blockWatch.events.on('best-blocks', async best => {
      try {
        const bestBlockNumber = best.at(-1)!.blockNumber;
        if (bestBlockNumber !== this.#bestBlockNumber) {
          this.#bestBlockNumber = bestBlockNumber;
          await this.updatePendingStatuses(best.at(-1)!);
        }
      } catch (error) {
        console.error('[TransactionTracker] Error watching for transaction updates:', error);
      }
    });
  }

  private stopWatching() {
    this.#watchUnsubscribe?.();
    this.#watchUnsubscribe = undefined;
  }

  private async updatePendingStatuses(bestBlockInfo: IBlockHeaderInfo): Promise<void> {
    const finalizedBlockHeader = { ...this.blockWatch.finalizedBlockHeader };
    const finalizedAccountNonceByAddress = new Map<string, Promise<number | undefined>>();

    for (const txInfo of this.data.txInfos) {
      if (!this.isTrackedAsPending(txInfo)) {
        continue;
      }
      try {
        await this.runInTransactionStatusLane(txInfo.tx.id, async () => {
          if (!this.isTrackedAsPending(txInfo)) {
            return;
          }
          await this.reconcilePendingTransaction({
            txInfo,
            bestBlockInfo,
            finalizedBlockHeader,
            finalizedAccountNonceByAddress,
          });
        });
      } catch (error) {
        console.error(`[TransactionTracker] Error updating pending transaction #${txInfo.tx.id} status:`, error);
      }
    }
    if (this.data.txInfos.every(x => !this.isTrackedAsPending(x))) {
      this.stopWatching();
    }
  }

  private async reconcilePendingTransaction(args: {
    txInfo: TransactionInfo;
    bestBlockInfo: IBlockHeaderInfo;
    finalizedBlockHeader: IBlockHeaderInfo;
    finalizedAccountNonceByAddress: Map<string, Promise<number | undefined>>;
  }): Promise<TxReconciliationState> {
    const { txInfo, bestBlockInfo, finalizedBlockHeader, finalizedAccountNonceByAddress } = args;
    const { tx, txResult } = txInfo;
    const finalizedHeight = finalizedBlockHeader.blockNumber;
    const finalizedBlockTime = finalizedBlockHeader.blockTime;
    const reconciliationHead = `${bestBlockInfo.blockNumber}:${bestBlockInfo.blockHash}:${finalizedHeight}:${finalizedBlockHeader.blockHash}`;
    const cachedReconciliation = this.#reconciliationByTxId.get(tx.id);
    if (cachedReconciliation?.head === reconciliationHead) {
      return cachedReconciliation.state;
    }

    const table = await this.getTable();
    let reconciliationState: TxReconciliationState | undefined;
    const latestHistoryStatus = this.getLatestHistoryStatus(tx.id);
    const shouldRescanBestBlockTx =
      latestHistoryStatus === TransactionHistoryStatus.Retracted || this.isNonResumableWatchStatus(latestHistoryStatus);

    if (tx.blockHeight) {
      if (tx.blockHeight <= finalizedHeight) {
        const finalizedHash = await this.blockWatch.getFinalizedHash(tx.blockHeight);
        if (finalizedHash === tx.blockHash) {
          await table.markFinalized(tx, {
            blockNumber: finalizedHeight,
            blockTime: new Date(finalizedBlockTime),
          });
          await txResult.setFinalized();
          reconciliationState = TxReconciliationState.Included;
        }
      } else if (!shouldRescanBestBlockTx) {
        reconciliationState = TxReconciliationState.Included;
      }
    }

    const MAX_BLOCKS_TO_CHECK = 60;
    if (!reconciliationState) {
      const searchStartBlockHeight = this.getSearchStartBlockHeight(tx);
      const maxBlocksToCheck = Math.min(
        MAX_BLOCKS_TO_CHECK,
        Math.max(0, bestBlockInfo.blockNumber - searchStartBlockHeight),
      );
      const findTransactionResult = await TransactionEvents.findByExtrinsicHash({
        blockWatch: this.blockWatch,
        extrinsicHash: tx.extrinsicHash,
        maxBlocksToCheck,
        bestBlockHeight: bestBlockInfo.blockNumber,
        searchStartBlockHeight,
        blockCache: this.#blockCache,
      });
      if (findTransactionResult) {
        reconciliationState = TxReconciliationState.Included;
        if (tx.blockHash === findTransactionResult.blockHash) {
          const { extrinsicEvents, ...txResultDetails } = findTransactionResult;
          console.log('[TransactionTracker] No change in block', {
            id: tx.id,
            ...txResultDetails,
            transactionEvents: extrinsicEvents.map(x => x.toHuman()),
          });
        } else {
          const { blockHash, blockNumber, blockTime, fee, tip, error, extrinsicEvents, extrinsicIndex } =
            findTransactionResult;
          await table.recordInBlock(tx, {
            blockNumber,
            blockHash,
            blockTime: new Date(blockTime),
            feePlusTip: fee,
            tip,
            extrinsicError: error,
            transactionEvents: extrinsicEvents,
            extrinsicIndex,
          });
          await txResult.setSeenInBlock({
            blockHash: hexToU8a(blockHash),
            blockNumber,
            events: extrinsicEvents,
            extrinsicIndex,
          });

          if (blockNumber <= finalizedHeight) {
            await table.markFinalized(tx, {
              blockNumber: finalizedHeight,
              blockTime: new Date(finalizedBlockTime),
            });
            await txResult.setFinalized();
          }
        }
      } else {
        reconciliationState = TxReconciliationState.Absent;
        console.log('[TransactionTracker] No transaction found as of block', {
          bestBlockNumber: bestBlockInfo.blockNumber,
          id: tx.id,
        });

        if (tx.txNonce != null && tx.finalizedHeadHeight !== finalizedHeight) {
          let finalizedAccountNoncePromise = finalizedAccountNonceByAddress.get(tx.accountAddress);
          if (!finalizedAccountNoncePromise) {
            finalizedAccountNoncePromise = (async () => {
              try {
                const api = await this.blockWatch.getApi(finalizedBlockHeader);
                const account = await api.query.system.account(tx.accountAddress);
                return account.nonce.toNumber();
              } catch (error) {
                console.warn('[TransactionTracker] Unable to check finalized account nonce', {
                  accountAddress: tx.accountAddress,
                  finalizedHeight,
                  error,
                });
              }
            })();
            finalizedAccountNonceByAddress.set(tx.accountAddress, finalizedAccountNoncePromise);
          }

          const finalizedAccountNonce = await finalizedAccountNoncePromise;
          if (finalizedAccountNonce === undefined) {
            reconciliationState = TxReconciliationState.Unavailable;
          } else if (finalizedAccountNonce > tx.txNonce) {
            const error = new TxSubmissionError(
              TxSubmissionErrorCode.Invalid,
              'Transaction nonce was already used by another transaction.',
            );
            txResult.submissionError = error;
            await this.recordHistoryStatus({
              transactionId: tx.id,
              status: TransactionHistoryStatus.Invalid,
              source: TransactionHistorySource.Local,
            });
            await this.recordSubmissionError(tx, error);
            return TxReconciliationState.Absent;
          }
        }

        if (
          reconciliationState === TxReconciliationState.Absent &&
          finalizedHeight - tx.submittedAtBlockHeight > MAX_BLOCKS_TO_CHECK
        ) {
          try {
            if (await this.isInTransactionPool(tx.extrinsicHash)) {
              reconciliationState = TxReconciliationState.InPool;
            } else {
              console.log(`[TransactionTracker] Marking transaction #${tx.id} expired:`, tx.extrinsicHash);
              txResult.extrinsicError = new Error('Transaction expired waiting for block inclusion');
              await txResult.setFinalized();
              await table.markExpiredWaitingForBlock(tx);
            }
          } catch (error) {
            console.warn('[TransactionTracker] Unable to check transaction pool before expiring transaction', {
              transactionId: tx.id,
              error,
            });
            reconciliationState = TxReconciliationState.Unavailable;
          }
        }
      }
    }

    if (reconciliationState === TxReconciliationState.Unavailable) {
      return reconciliationState;
    }
    if (tx.status !== TransactionStatus.Finalized && tx.status !== TransactionStatus.Error) {
      await table.updateFinalizedHead(tx, {
        blockNumber: finalizedHeight,
        blockTime: new Date(finalizedBlockTime),
      });
      txInfo.finalizedHeadHeight = finalizedHeight;
    }
    if (reconciliationState === TxReconciliationState.InPool) {
      return reconciliationState;
    }

    this.#reconciliationByTxId.set(tx.id, { head: reconciliationHead, state: reconciliationState });
    return reconciliationState;
  }

  private async isInTransactionPool(extrinsicHash: string): Promise<boolean> {
    const client = await getMainchainClient(false);
    const pendingExtrinsics = await client.rpc.author.pendingExtrinsics();
    return pendingExtrinsics.some(extrinsic => extrinsic.hash.toHex() === extrinsicHash);
  }

  private async getTable(): Promise<TransactionsTable> {
    this.#table ??= await this.dbPromise.then(x => x.transactionsTable);
    return this.#table;
  }

  private async getHistoryTable(): Promise<TransactionStatusHistoryTable> {
    this.#historyTable ??= await this.dbPromise.then(x => x.transactionStatusHistoryTable);
    return this.#historyTable;
  }

  private getSearchStartBlockHeight(tx: ITransactionRecord): number {
    if (tx.finalizedHeadHeight === undefined) {
      return tx.submittedAtBlockHeight;
    }

    // Start from the last finalized head we processed so a tx that reappears on
    // the canonical chain at that boundary is still rediscovered.
    return Math.max(tx.submittedAtBlockHeight, tx.finalizedHeadHeight);
  }

  private async recordSubmissionError(record: ITransactionRecord, error: Error) {
    if (record.status === TransactionStatus.Error) return;
    const table = await this.getTable();
    await table.recordSubmissionError(record, error);
  }

  private async runInTransactionStatusLane<T>(transactionId: number, callback: () => Promise<T>): Promise<T> {
    const priorLane = this.#statusLaneByTxId.get(transactionId) ?? Promise.resolve();
    let releaseLane!: VoidFunction;
    const lane = new Promise<void>(resolve => {
      releaseLane = resolve;
    });
    const currentLane = priorLane.then(() => lane);
    this.#statusLaneByTxId.set(transactionId, currentLane);

    await priorLane;
    try {
      return await callback();
    } finally {
      releaseLane();
      if (this.#statusLaneByTxId.get(transactionId) === currentLane) {
        this.#statusLaneByTxId.delete(transactionId);
      }
    }
  }

  private async reserveLatestNonce(
    client: Awaited<ReturnType<typeof getMainchainClient>>,
    address: string,
  ): Promise<{ nonce: number; release: VoidFunction }> {
    const priorLane = this.#nonceLaneByAddress.get(address) ?? Promise.resolve();
    let releaseLane!: VoidFunction;
    const lane = new Promise<void>(resolve => {
      releaseLane = resolve;
    });
    const currentLane = priorLane.then(() => lane);
    this.#nonceLaneByAddress.set(address, currentLane);

    await priorLane;
    try {
      const nextChainNonce = (await client.rpc.system.accountNextIndex(address)).toNumber();
      return {
        nonce: Math.max(nextChainNonce, this.getNextPendingNonce(address)),
        release: () => {
          releaseLane();
          if (this.#nonceLaneByAddress.get(address) === currentLane) {
            this.#nonceLaneByAddress.delete(address);
          }
        },
      };
    } catch (error) {
      releaseLane();
      if (this.#nonceLaneByAddress.get(address) === currentLane) {
        this.#nonceLaneByAddress.delete(address);
      }
      throw error;
    }
  }

  private getNextPendingNonce(address: string): number {
    let nextNonce = 0;

    for (const txInfo of this.data.txInfos) {
      if (!this.reservesNonceLane(txInfo, address) || txInfo.tx.txNonce == null) continue;
      nextNonce = Math.max(nextNonce, txInfo.tx.txNonce + 1);
    }

    return nextNonce;
  }

  private async handleWatchedResult(record: ITransactionRecord, txResult: TxResult, result: ISubmittableResult) {
    if (this.#isClosed) {
      return;
    }
    this.#pendingWatchResultsByTxId.set(record.id, (this.#pendingWatchResultsByTxId.get(record.id) ?? 0) + 1);

    try {
      await this.runInTransactionStatusLane(record.id, async () => {
        if (this.#isClosed) {
          return;
        }
        const { status } = result;
        const isInBlock = status.isInBlock;
        const isFinalized = status.isFinalized || txResult.isFinalized;
        let blockHash: string | undefined;
        if (isInBlock) {
          blockHash = status.asInBlock.toHex();
        } else if (status.isFinalized) {
          blockHash = status.asFinalized.toHex();
        }
        const submissionError = txResult.submissionError;

        await this.recordWatchStatus(record, {
          isBroadcast: status.isBroadcast,
          isInBlock,
          isFinalized,
          isRetracted: status.isRetracted,
          isUsurped: status.isUsurped,
          isDropped: status.isDropped,
          isInvalid: status.isInvalid,
          blockHash,
          blockNumber: txResult.blockNumber,
          replacementTxHash: status.isUsurped ? status.asUsurped.toHex() : undefined,
        });
        if (submissionError) {
          await this.recordSubmissionError(record, submissionError);
        }
      });
    } catch (error) {
      console.error(`[TransactionTracker] Error handling watched tx #${record.id} update`, error);
    } finally {
      const pendingWatchResults = (this.#pendingWatchResultsByTxId.get(record.id) ?? 1) - 1;
      if (pendingWatchResults > 0) {
        this.#pendingWatchResultsByTxId.set(record.id, pendingWatchResults);
      } else {
        this.#pendingWatchResultsByTxId.delete(record.id);
      }
    }
  }

  private async recordWatchStatus(
    record: ITransactionRecord,
    {
      isBroadcast,
      isInBlock,
      isFinalized,
      isRetracted,
      isUsurped,
      isDropped,
      isInvalid,
      blockHash,
      blockNumber,
      replacementTxHash,
    }: IWatchedTxStatus,
  ) {
    this.#reconciliationByTxId.delete(record.id);

    if (isBroadcast) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Broadcast,
        source: TransactionHistorySource.Watch,
      });
    }

    if (isInBlock) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.InBlock,
        source: TransactionHistorySource.Watch,
        blockHeight: blockNumber,
        blockHash,
      });
    }

    if (isFinalized) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Finalized,
        source: TransactionHistorySource.Watch,
        blockHeight: blockNumber,
        blockHash,
      });
    }

    if ((isInBlock || isFinalized) && blockNumber != null && blockHash) {
      const findTransactionResult = await TransactionEvents.findByExtrinsicHashInBlock({
        blockWatch: this.blockWatch,
        extrinsicHash: record.extrinsicHash,
        block: {
          blockNumber,
          blockHash,
        },
        blockCache: this.#blockCache,
      });

      if (findTransactionResult) {
        const table = await this.getTable();
        const { blockHash, blockTime, fee, tip, error, extrinsicEvents, extrinsicIndex } = findTransactionResult;

        await table.recordInBlock(record, {
          blockNumber,
          blockHash,
          blockTime: new Date(blockTime),
          feePlusTip: fee,
          tip,
          extrinsicError: error,
          transactionEvents: extrinsicEvents,
          extrinsicIndex,
        });

        if (isFinalized) {
          const finalizedBlockNumber = Math.max(this.blockWatch.finalizedBlockHeader.blockNumber, blockNumber);
          const finalizedBlockTime =
            finalizedBlockNumber === blockNumber
              ? new Date(blockTime)
              : new Date(this.blockWatch.finalizedBlockHeader.blockTime);

          await table.markFinalized(record, {
            blockNumber: finalizedBlockNumber,
            blockTime: finalizedBlockTime,
          });
        }
      }
    }

    if (isRetracted) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Retracted,
        source: TransactionHistorySource.Watch,
      });
    }

    if (isUsurped && replacementTxHash) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Usurped,
        source: TransactionHistorySource.Watch,
        replacementTxHash,
      });
    }

    if (isDropped) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Dropped,
        source: TransactionHistorySource.Watch,
      });
    }

    if (isInvalid) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Invalid,
        source: TransactionHistorySource.Watch,
      });
    }
  }

  private async recordHistoryStatus(entry: Parameters<TransactionStatusHistoryTable['record']>[0]) {
    const historyTable = await this.getHistoryTable();
    const latest = await historyTable.record(entry);
    if (!latest) return;
    this.#latestHistoryByTxId.set(entry.transactionId, latest);
  }

  private getLatestHistoryStatus(transactionId: number) {
    return this.#latestHistoryByTxId.get(transactionId)?.status;
  }

  private isPendingTxInfoAtLoad(txInfo: TransactionInfo) {
    if (txInfo.statusAtLoad !== TransactionStatus.Submitted && txInfo.statusAtLoad !== TransactionStatus.InBlock) {
      return false;
    }

    const latestWatchStatus = this.getLatestHistoryStatus(txInfo.tx.id);
    return !this.isNonResumableWatchStatus(latestWatchStatus);
  }

  private isTrackedAsPending(txInfo: TransactionInfo) {
    if (txInfo.tx.status !== TransactionStatus.Submitted && txInfo.tx.status !== TransactionStatus.InBlock) {
      return false;
    }
    if (txInfo.txResult.submissionError) {
      return false;
    }
    return !this.isNonResumableWatchStatus(this.getLatestHistoryStatus(txInfo.tx.id));
  }

  private reservesNonceLane(txInfo: TransactionInfo, address: string) {
    if (txInfo.tx.accountAddress !== address) return false;
    if (!this.isTrackedAsPending(txInfo)) return false;
    return !this.isNonResumableWatchStatus(this.getLatestHistoryStatus(txInfo.tx.id));
  }

  private isNonResumableWatchStatus(status?: TransactionHistoryStatus) {
    if (!status) return false;
    return (
      status === TransactionHistoryStatus.Dropped ||
      status === TransactionHistoryStatus.Usurped ||
      status === TransactionHistoryStatus.Invalid
    );
  }

  private shouldRestoreStoredEventsAtLoad(txInfo: TransactionInfo) {
    return !!txInfo.tx.blockExtrinsicEventsJson?.length && this.isPendingTxInfoAtLoad(txInfo);
  }
}
