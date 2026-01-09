import {
  ArgonClient,
  ExtrinsicError,
  GenericEvent,
  hexToU8a,
  ISubmittableOptions,
  KeyringPair,
  SignedBlock,
  SubmittableExtrinsic,
  TxResult,
  TxSubmitter,
  u8aToHex,
} from '@argonprotocol/mainchain';
import * as Vue from 'vue';
import { Db } from './Db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { BlockWatch, createDeferred, IBlockHeaderInfo, IDeferred, TransactionEvents } from '@argonprotocol/apps-core';
import { ExtrinsicType, ITransactionRecord, TransactionsTable, TransactionStatus } from './db/TransactionsTable.ts';
import { LRU } from 'tiny-lru';
import { TransactionInfo } from './TransactionInfo.ts';

const PENDING_STATUSES = [TransactionStatus.Submitted, TransactionStatus.InBlock];

export class TransactionTracker {
  public data: {
    txInfos: TransactionInfo[];
    txInfosByType: Partial<Record<ExtrinsicType, TransactionInfo>>;
  };

  #waitForLoad?: IDeferred;
  #table?: TransactionsTable;
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
    return this.data.txInfos.filter(
      x => x.statusAtLoad === TransactionStatus.Submitted || x.statusAtLoad === TransactionStatus.InBlock,
    );
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad ??= createDeferred();
    try {
      const table = await this.getTable();
      const txs = await table.fetchAll();
      const client = await getMainchainClient(false);
      await this.blockWatch.start();

      this.data.txInfos.length = 0;
      for (const tx of txs) {
        const txResult = new TxResult(client, {
          accountAddress: tx.accountAddress,
          method: tx.extrinsicMethodJson,
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
      if (this.data.txInfos.some(x => PENDING_STATUSES.includes(x.tx.status))) {
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
    const { tx, signer, extrinsicType, metadata } = args;
    const client = await getMainchainClient(false);
    const txSubmitter = new TxSubmitter(client, tx, signer);

    console.log('[TransactionTracker] SUBMITTING TRANSACTION', extrinsicType);
    const txResult = await txSubmitter.submit({
      ...args,
      disableAutomaticTxTracking: true,
    });
    return this.trackTxResult({
      txResult,
      extrinsicType,
      metadata,
    });
  }

  public createIntentForFollowOnTx<T>(txInfo: TransactionInfo): IDeferred<TransactionInfo<T>> {
    const deferred = txInfo.registerDeferredFollowOnTx<T>();
    void deferred.promise.then(async x => {
      const table = await this.getTable();
      await table.recordFollowOnTxId(txInfo.tx, x.tx.id);
    });

    return deferred;
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

    const extrinsicHash = txResult.extrinsic.signedHash;
    const record = await table.insert({
      extrinsicHash,
      extrinsicMethodJson: txResult.extrinsic.method,
      metadataJson: metadata,
      extrinsicType,
      accountAddress: txResult.extrinsic.accountAddress,
      submittedAtBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
      submittedAtTime: txResult.extrinsic.submittedTime,
    });

    // Mark txResult as non-reactive to avoid issues with private fields
    Vue.markRaw(txResult);
    const txInfo = new TransactionInfo<T>({ tx: record, txResult });
    this.data.txInfos.unshift(txInfo);
    this.data.txInfosByType[extrinsicType] = txInfo;
    if (txResult.submissionError) {
      await table.recordSubmissionError(record, txResult.submissionError);
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

  private async findTransactionInBlocks(
    tx: ITransactionRecord,
    maxBlocksToCheck: number,
    bestBlockHeight: number,
  ): Promise<
    | {
        blockNumber: number;
        blockHash: string;
        blockTime: number;
        extrinsicError?: ExtrinsicError;
        extrinsicIndex: number;
        txFeePlusTip: bigint;
        tip: bigint;
        transactionEvents: GenericEvent[];
      }
    | undefined
  > {
    const { extrinsicHash, submittedAtBlockHeight } = tx;

    for (let i = 0; i <= maxBlocksToCheck; i++) {
      const blockHeight = submittedAtBlockHeight + i;
      if (blockHeight > bestBlockHeight) {
        return undefined;
      }
      const blockHeader = await this.blockWatch.getHeader(blockHeight);
      const blockHash = blockHeader.blockHash;
      const blockTime = blockHeader.blockTime;
      const client = await this.blockWatch.getRpcClient(blockHeight);
      const block = await this.getBlock(client, blockHash);
      console.log(`[TransactionTracker] Searching block with ${block.block.extrinsics.length} extrinsics`, {
        blockHeight,
        blockHash,
        submittedAtBlockHeight,
      });
      for (const [index, extrinsic] of block.block.extrinsics.entries()) {
        if (u8aToHex(extrinsic.hash) === extrinsicHash) {
          const api = await client.at(blockHash);
          const events = await api.query.system.events();
          const result = await TransactionEvents.getErrorAndFeeForTransaction({
            client,
            extrinsicIndex: index,
            events,
          });

          console.log(`[TransactionTracker] Found extrinsic`, {
            blockHeight,
            blockHash,
            extrinsicHash,
          });
          return {
            blockNumber: blockHeight,
            blockHash,
            extrinsicError: result.error,
            txFeePlusTip: result.fee + result.tip,
            tip: result.tip,
            transactionEvents: result.extrinsicEvents,
            extrinsicIndex: index,
            blockTime,
          };
        }
      }
    }
  }

  private async updatePendingStatuses(bestBlockInfo: IBlockHeaderInfo): Promise<void> {
    const table = await this.getTable();
    const { blockNumber: finalizedHeight, blockTime: finalizedBlockTime } = this.blockWatch.finalizedBlockHeader;
    const bestBlockNumber = bestBlockInfo.blockNumber;

    for (const txInfo of this.data.txInfos) {
      const { tx, txResult } = txInfo;
      if (!PENDING_STATUSES.includes(tx.status)) {
        continue;
      }
      try {
        if (tx.blockHeight && tx.blockHeight <= finalizedHeight) {
          // ensure this block hash is still valid
          const finalizedHash = await this.blockWatch.getFinalizedHash(tx.blockHeight);
          if (finalizedHash === tx.blockHash) {
            await table.markFinalized(tx);
            txResult.setFinalized();
            continue;
          }
        }

        // first check if we can find the transaction (this is particularly relevant if we re-open the app after 60 blocks)
        const MAX_BLOCKS_TO_CHECK = 60;
        const findTransactionResult = await this.findTransactionInBlocks(
          tx,
          MAX_BLOCKS_TO_CHECK,
          bestBlockInfo.blockNumber,
        );
        if (findTransactionResult) {
          const originalBlockHash = tx.blockHash;
          if (originalBlockHash === findTransactionResult.blockHash) {
            // no change
            const { transactionEvents, ...txResult } = findTransactionResult;
            console.log('[TransactionTracker] No change in block', {
              id: tx.id,
              ...txResult,
              transactionEvents: transactionEvents.map(x => x.toHuman()),
            });
            continue;
          }
          const {
            blockHash,
            blockNumber,
            blockTime,
            txFeePlusTip,
            tip,
            extrinsicError,
            transactionEvents,
            extrinsicIndex,
          } = findTransactionResult;
          const u8aBlockHash = hexToU8a(blockHash);
          await table.recordInBlock(tx, {
            blockNumber: blockNumber,
            blockHash,
            blockTime: new Date(blockTime),
            feePlusTip: txFeePlusTip,
            tip: tip,
            extrinsicError,
            transactionEvents,
            extrinsicIndex,
          });
          await txResult.setSeenInBlock({
            blockHash: u8aBlockHash,
            blockNumber: blockNumber,
            events: transactionEvents,
            extrinsicIndex,
          });

          if (findTransactionResult.blockNumber <= finalizedHeight) {
            await table.markFinalized(tx);
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
      await table.updateLastFinalizedBlock(txInfo.tx, {
        blockNumber: finalizedHeight,
        blockTime: new Date(finalizedBlockTime),
      });
      txInfo.finalizedBlockHeight = finalizedHeight;
    }
    if (this.data.txInfos.every(x => !PENDING_STATUSES.includes(x.tx.status))) {
      this.stopWatching();
    }
  }

  private async getTable(): Promise<TransactionsTable> {
    this.#table ??= await this.dbPromise.then(x => x.transactionsTable);
    return this.#table;
  }

  private async getBlock(client: ArgonClient, blockHash: string): Promise<SignedBlock> {
    const cached = this.#blockCache.get(blockHash);
    if (cached) {
      return cached;
    }
    const block = await client.rpc.chain.getBlock(blockHash);
    this.#blockCache.set(blockHash, block);
    return block;
  }
}
