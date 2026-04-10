import {
  ExtrinsicError,
  hexToU8a,
  ISubmittableOptions,
  KeyringPair,
  SignedBlock,
  SubmittableExtrinsic,
  TxResult,
} from '@argonprotocol/mainchain';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
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

type IWatchedTxResult = ISubmittableResult & { blockNumber?: number };

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
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad ??= createDeferred();
    try {
      const table = await this.getTable();
      const txs = await table.fetchAll();
      this.#latestHistoryByTxId = await this.getHistoryTable().then(x =>
        x.fetchLatestByTransactionIds(txs.map(y => y.id)),
      );
      const client = await getMainchainClient(false);
      await this.blockWatch.start();

      this.data.txInfos.length = 0;
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
        if (tx.blockExtrinsicErrorJson) {
          txResult.extrinsicError = new ExtrinsicError(
            tx.blockExtrinsicErrorJson.errorCode ?? 'Unknown Error',
            tx.blockExtrinsicErrorJson.details ?? tx.blockExtrinsicErrorJson.message,
            tx.blockExtrinsicErrorJson.batchInterruptedIndex,
          );
        }
        if (tx.blockHeight) {
          void txResult.setSeenInBlock({
            blockHash: hexToU8a(tx.blockHash),
            blockNumber: tx.blockHeight,
            extrinsicIndex: tx.blockExtrinsicIndex!,
            events: [],
          });
        }
        if (tx.blockExtrinsicEventsJson) {
          try {
            txResult.events = tx.blockExtrinsicEventsJson.map(({ raw }) =>
              client.createType('GenericEvent', hexToU8a(raw)),
            );
          } catch (error) {
            console.error(
              `[TransactionTracker] Error restoring events for transaction #${tx.id} (${tx.extrinsicType})`,
              error,
            );
          }
        }

        if (tx.isFinalized || txResult.extrinsicError || txResult.submissionError) {
          txResult.setFinalized();
        }
        // Mark txResult as non-reactive to avoid issues with private fields
        Vue.markRaw(txResult);
        const txInfo = new TransactionInfo({
          tx,
          txResult,
        });
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
      }
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('[TransactionTracker] Error restoring transactions', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async submitAndWatch<T>(
    args: {
      tx: SubmittableExtrinsic;
      signer: KeyringPair;
      extrinsicType: ExtrinsicType;
      metadata?: T;
    } & ISubmittableOptions,
  ): Promise<TransactionInfo<T>> {
    const { tx, signer, extrinsicType, metadata, useLatestNonce, ...apiOptions } = args;
    const client = await getMainchainClient(false);
    console.log('[TransactionTracker] SUBMITTING TRANSACTION', extrinsicType);
    const submittedAtBlockHeight = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
    if (useLatestNonce && apiOptions.nonce === undefined) {
      apiOptions.nonce = await client.rpc.system.accountNextIndex(signer.address);
    }
    const signedTx = await tx.signAsync(signer, apiOptions);
    const txResultExtrinsic = {
      signedHash: signedTx.hash.toHex(),
      method: signedTx.method.toHuman(),
      nonce: signedTx.nonce.toNumber(),
      accountAddress: signer.address,
      submittedTime: new Date(),
      submittedAtBlockNumber: submittedAtBlockHeight,
    };
    const txResult = new TxResult(client, txResultExtrinsic);
    const txInfo = await this.trackTxResult({
      txResult,
      extrinsicType,
      metadata,
    });
    try {
      await signedTx.send(result => {
        txResult.onSubscriptionResult(result);
        void this.handleWatchedResult(txInfo.tx, txResult, result);
      });
    } catch (error) {
      txResult.submissionError = error as Error;
      await this.recordSubmissionError(txInfo.tx, txResult.submissionError);
    }
    return txInfo;
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
    const { txResult, extrinsicType, metadata } = args;
    const table = await this.getTable();
    const txNonce = txResult.extrinsic.nonce;

    const extrinsicHash = txResult.extrinsic.signedHash;
    const record = await table.insert({
      extrinsicHash,
      extrinsicMethodJson: txResult.extrinsic.method,
      metadataJson: metadata,
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
    await this.watchForUpdates();

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
              txResult.setFinalized();
              continue;
            }
          } else if (!shouldRescanBestBlockTx) {
            // The tx is already in a best block. Wait for finalization before attempting
            // expensive relocation scans across the recent chain window.
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
            txResult.setFinalized();
          }
        } else {
          console.log('[TransactionTracker] No transaction found as of block', { bestBlockNumber, id: tx.id });

          if (finalizedHeight - tx.submittedAtBlockHeight > MAX_BLOCKS_TO_CHECK) {
            // too old, stop checking
            console.log(`[TransactionTracker] Marking transaction #${tx.id} expired:`, tx.extrinsicHash);
            txResult.extrinsicError = new Error('Transaction expired waiting for block inclusion');
            txResult.setFinalized();
            await table.markExpiredWaitingForBlock(tx);
          }
        }
      } catch (error) {
        console.error(`[TransactionTracker] Error updating pending transaction #${tx.id} status:`, error);
      }
    }
    for (const txInfo of this.data.txInfos) {
      if (txInfo.tx.status === TransactionStatus.Finalized || txInfo.tx.status === TransactionStatus.Error) continue;
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

  private async handleWatchedResult(record: ITransactionRecord, txResult: TxResult, result: IWatchedTxResult) {
    try {
      await this.recordWatchStatus(record, result);
      if (txResult.submissionError) {
        await this.recordSubmissionError(record, txResult.submissionError);
      }
    } catch (error) {
      console.error(`[TransactionTracker] Error handling watched tx #${record.id} update`, error);
    }
  }

  private async recordWatchStatus(record: ITransactionRecord, result: IWatchedTxResult) {
    const { blockNumber, status } = result;

    if (status.isBroadcast) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Broadcast,
        source: TransactionHistorySource.Watch,
      });
    }

    if (status.isInBlock) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.InBlock,
        source: TransactionHistorySource.Watch,
        blockHeight: blockNumber,
        blockHash: status.asInBlock?.toHex(),
      });
    }

    if (status.isFinalized) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Finalized,
        source: TransactionHistorySource.Watch,
        blockHeight: blockNumber,
        blockHash: status.asFinalized?.toHex(),
      });
    }

    if (status.isRetracted) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Retracted,
        source: TransactionHistorySource.Watch,
      });
    }

    if (status.isUsurped) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Usurped,
        source: TransactionHistorySource.Watch,
        replacementTxHash: status.asUsurped.toHex(),
      });
    }

    if (status.isDropped) {
      await this.recordHistoryStatus({
        transactionId: record.id,
        status: TransactionHistoryStatus.Dropped,
        source: TransactionHistorySource.Watch,
      });
    }

    if (status.isInvalid) {
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

  private isNonResumableWatchStatus(status?: TransactionHistoryStatus) {
    if (!status) return false;
    return (
      status === TransactionHistoryStatus.Dropped ||
      status === TransactionHistoryStatus.Usurped ||
      status === TransactionHistoryStatus.Invalid
    );
  }
}
