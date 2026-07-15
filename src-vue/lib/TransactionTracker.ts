import {
  type ArgonClient,
  ExtrinsicError,
  type GenericEvent,
  hexToU8a,
  ISubmittableOptions,
  type ISubmittableResult,
  SignedBlock,
  SubmittableExtrinsic,
  type TxSigningAccount,
  TxResult,
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
  Follow = 'Follow',
  Finalized = 'Finalized',
  Replace = 'Replace',
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
    const { client: providedClient, tx, txSigner, extrinsicType, metadata, useLatestNonce, ...apiOptions } = args;
    await this.load();
    const client = providedClient ?? (await getMainchainClient(false));
    console.log('[TransactionTracker] SUBMITTING TRANSACTION', extrinsicType);
    const submittedAtBlockHeight = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
    let releaseNonceReservation: VoidFunction | undefined;
    if (useLatestNonce && apiOptions.nonce === undefined) {
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

      await signedTx
        .send(result => {
          if (this.#isClosed) {
            return;
          }
          txResult.onSubscriptionResult(result);
          void this.handleWatchedResult(txInfo.tx, txResult, result);
        })
        .catch(async error => {
          if (this.#isClosed) {
            return;
          }
          txResult.submissionError = error as Error;
          await this.recordSubmissionError(txInfo.tx, txResult.submissionError);
        });
    } finally {
      releaseNonceReservation?.();
    }

    await this.watchForUpdates();

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

  public async getTxAttemptState(
    txInfo: TransactionInfo,
    followWindowFinalizedBlocks: number,
  ): Promise<TxAttemptState> {
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

    const finalizedHeight = this.blockWatch.finalizedBlockHeader.blockNumber;

    if (txInfo.tx.status === TransactionStatus.Submitted) {
      if (finalizedHeight - txInfo.tx.submittedAtBlockHeight <= followWindowFinalizedBlocks) {
        return TxAttemptState.Follow;
      }
      return TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.InBlock) {
      const { blockHash, blockHeight } = txInfo.tx;
      if (!blockHash || blockHeight == null) {
        return TxAttemptState.Replace;
      }

      const header = await this.blockWatch.getHeader(blockHeight).catch(() => undefined);
      if (!header) {
        return TxAttemptState.Follow;
      }
      if (header.blockHash === blockHash) {
        return TxAttemptState.Follow;
      }
      if (finalizedHeight - blockHeight <= followWindowFinalizedBlocks) {
        return TxAttemptState.Follow;
      }

      return TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.Finalized) {
      return TxAttemptState.Finalized;
    }

    return TxAttemptState.Replace;
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
    const table = await this.getTable();
    const { blockNumber: finalizedHeight, blockTime: finalizedBlockTime } = this.blockWatch.finalizedBlockHeader;
    const bestBlockNumber = bestBlockInfo.blockNumber;
    const checkedTxIds = new Set<number>();

    for (const txInfo of this.data.txInfos) {
      const { tx, txResult } = txInfo;
      if (!this.isTrackedAsPending(txInfo)) {
        continue;
      }
      try {
        const latestHistoryStatus = this.getLatestHistoryStatus(tx.id);
        const shouldRescanBestBlockTx =
          latestHistoryStatus === TransactionHistoryStatus.Retracted ||
          this.isNonResumableWatchStatus(latestHistoryStatus);

        if (tx.blockHeight) {
          if (tx.blockHeight <= finalizedHeight) {
            // ensure this block hash is still valid
            const finalizedHash = await this.blockWatch.getFinalizedHash(tx.blockHeight);
            if (finalizedHash === tx.blockHash) {
              await table.markFinalized(tx, {
                blockNumber: finalizedHeight,
                blockTime: new Date(finalizedBlockTime),
              });
              await txResult.setFinalized();
              checkedTxIds.add(tx.id);
              continue;
            }
          } else if (!shouldRescanBestBlockTx) {
            // The tx is already in a best block. Wait for finalization before attempting
            // expensive relocation scans across the recent chain window.
            checkedTxIds.add(tx.id);
            continue;
          }
        }

        // first check if we can find the transaction (this is particularly relevant if we re-open the app after 60 blocks)
        const MAX_BLOCKS_TO_CHECK = 60;
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
          const originalBlockHash = tx.blockHash;
          if (originalBlockHash === findTransactionResult.blockHash) {
            // no change
            const { extrinsicEvents, ...txResult } = findTransactionResult;
            console.log('[TransactionTracker] No change in block', {
              id: tx.id,
              ...txResult,
              transactionEvents: extrinsicEvents.map(x => x.toHuman()),
            });
            checkedTxIds.add(tx.id);
            continue;
          }
          const { blockHash, blockNumber, blockTime, fee, tip, error, extrinsicEvents, extrinsicIndex } =
            findTransactionResult;
          const u8aBlockHash = hexToU8a(blockHash);
          await table.recordInBlock(tx, {
            blockNumber: blockNumber,
            blockHash,
            blockTime: new Date(blockTime),
            feePlusTip: fee + tip,
            tip: tip,
            extrinsicError: error,
            transactionEvents: extrinsicEvents,
            extrinsicIndex,
          });
          await txResult.setSeenInBlock({
            blockHash: u8aBlockHash,
            blockNumber: blockNumber,
            events: extrinsicEvents,
            extrinsicIndex,
          });

          if (findTransactionResult.blockNumber <= finalizedHeight) {
            await table.markFinalized(tx, {
              blockNumber: finalizedHeight,
              blockTime: new Date(finalizedBlockTime),
            });
            await txResult.setFinalized();
          }
        } else {
          console.log('[TransactionTracker] No transaction found as of block', { bestBlockNumber, id: tx.id });

          if (finalizedHeight - tx.submittedAtBlockHeight > MAX_BLOCKS_TO_CHECK) {
            // too old, stop checking
            console.log(`[TransactionTracker] Marking transaction #${tx.id} expired:`, tx.extrinsicHash);
            txResult.extrinsicError = new Error('Transaction expired waiting for block inclusion');
            await txResult.setFinalized();
            await table.markExpiredWaitingForBlock(tx);
          }
        }
        checkedTxIds.add(tx.id);
      } catch (error) {
        console.error(`[TransactionTracker] Error updating pending transaction #${tx.id} status:`, error);
      }
    }
    for (const txInfo of this.data.txInfos) {
      if (txInfo.tx.status === TransactionStatus.Finalized || txInfo.tx.status === TransactionStatus.Error) continue;
      if (!checkedTxIds.has(txInfo.tx.id)) continue;
      await table.updateFinalizedHead(txInfo.tx, {
        blockNumber: finalizedHeight,
        blockTime: new Date(finalizedBlockTime),
      });
      txInfo.finalizedHeadHeight = finalizedHeight;
    }
    if (this.data.txInfos.every(x => !this.isTrackedAsPending(x))) {
      this.stopWatching();
    }
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
    try {
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
    } catch (error) {
      console.error(`[TransactionTracker] Error handling watched tx #${record.id} update`, error);
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
          feePlusTip: fee + tip,
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
    return true;
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
