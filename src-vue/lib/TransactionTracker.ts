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
import { Db } from './Db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createDeferred, IDeferred } from './Utils.ts';
import { TransactionFees } from '@argonprotocol/apps-core';
import { ExtrinsicType, ITransactionRecord, TransactionsTable, TransactionStatus } from './db/TransactionsTable.ts';
import { LRU } from 'tiny-lru';

export interface ITransactionInfo {
  tx: ITransactionRecord;
  txResult: TxResult;
  isProcessed: IDeferred;
  statusAtLoad?: TransactionStatus;
  progressCallbacks: ((args: {
    submittedBlock: number;
    includedInBlockNumber?: number;
    bestBlock: number;
    finalizedBlock: number;
    progress: number;
  }) => void)[];
}

const PENDING_STATUSES = [TransactionStatus.Submitted, TransactionStatus.InBlock];
export class TransactionTracker {
  public data: {
    transactions: ITransactionInfo[];
  };

  #waitForLoad?: IDeferred;
  #table?: TransactionsTable;
  #blockCache = new LRU<SignedBlock>(25);
  #watchUnsubscribe?: () => void;

  constructor(private readonly dbPromise: Promise<Db>) {
    this.data = {
      transactions: [],
    };
  }

  public get pendingBlockTransactionsAtLoad(): ITransactionInfo[] {
    return this.data.transactions.filter(
      x => x.statusAtLoad === TransactionStatus.Submitted || x.statusAtLoad === TransactionStatus.InBlock,
    );
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad ??= createDeferred();
    try {
      const table = await this.getTable();
      const txs = await table.fetchAll();
      const client = await getMainchainClient(true);
      this.data.transactions.length = 0;
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
            console.error('Error restoring events for transaction', tx.extrinsicHash, error);
          }
        }

        const isProcessed = createDeferred();
        if (tx.isFinalized || txResult.extrinsicError || txResult.submissionError) {
          txResult.setFinalized();
          isProcessed.resolve();
        }
        this.data.transactions.push({
          tx,
          txResult,
          statusAtLoad: tx.status,
          isProcessed,
          progressCallbacks: [],
        });
      }
      if (this.data.transactions.some(x => PENDING_STATUSES.includes(x.tx.status))) {
        await this.watchForUpdates();
      }
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error restoring transactions', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async submitAndWatch(
    args: {
      tx: SubmittableExtrinsic;
      signer: KeyringPair;
      extrinsicType: ExtrinsicType;
      metadata?: any;
    } & ISubmittableOptions,
  ): Promise<ITransactionInfo> {
    const { tx, signer, extrinsicType, metadata } = args;
    const client = await getMainchainClient(false);
    const txSubmitter = new TxSubmitter(client, tx, signer);
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

  public async trackTxResult(
    args: {
      txResult: TxResult;
      extrinsicType: ExtrinsicType;
      metadata?: any;
    } & ISubmittableOptions,
  ): Promise<ITransactionInfo> {
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
    await this.watchForUpdates();

    const entry = { tx: record, txResult, isProcessed: createDeferred(), progressCallbacks: [] };
    this.data.transactions.unshift(entry);
    if (txResult.submissionError) {
      await table.recordSubmissionError(record, txResult.submissionError);
    }

    return entry;
  }

  private async watchForUpdates() {
    const client = await getMainchainClient(false);

    this.#watchUnsubscribe ??= await client.rpc.chain.subscribeNewHeads(async bestHeader => {
      try {
        await this.updatePendingStatuses(bestHeader.number.toNumber());
      } catch (error) {
        console.error('Error watching for transaction updates:', error);
      }
    });
  }

  private stopWatching() {
    this.#watchUnsubscribe?.();
    this.#watchUnsubscribe = undefined;
  }

  private async findTransaction(
    tx: ITransactionRecord,
    client: ArgonClient,
    maxBlocksToCheck: number,
    bestBlockHeight: number,
  ): Promise<
    | {
        blockNumber: number;
        blockHash: string;
        extrinsicError?: ExtrinsicError;
        extrinsicIndex: number;
        txFeePlusTip: bigint;
        tip: bigint;
        transactionEvents: GenericEvent[];
      }
    | undefined
  > {
    const { extrinsicHash, accountAddress, submittedAtBlockHeight } = tx;

    for (let i = 0; i <= maxBlocksToCheck; i++) {
      const blockHeight = submittedAtBlockHeight + i;
      if (blockHeight > bestBlockHeight) {
        return undefined;
      }
      const blockHash = await client.rpc.chain.getBlockHash(blockHeight);
      const block = await this.getBlock(client, blockHash);
      console.log(`Searching block with ${block.block.extrinsics.length} extrinsics`, {
        blockHeight,
        blockHash: u8aToHex(blockHash),
        submittedAtBlockHeight,
      });
      for (const [index, extrinsic] of block.block.extrinsics.entries()) {
        if (u8aToHex(extrinsic.hash) === extrinsicHash) {
          const result = await TransactionFees.findFromEvents({
            client,
            blockHash,
            accountAddress,
            onlyMatchExtrinsicIndex: index,
            isMatchingEvent: () => true,
          });
          if (result) {
            console.log(`Found extrinsic`, {
              blockHeight,
              blockHash: u8aToHex(blockHash),
              extrinsicHash,
            });
            return {
              blockNumber: blockHeight,
              blockHash: u8aToHex(blockHash),
              extrinsicError: result.error,
              txFeePlusTip: result.fee + result.tip,
              tip: result.tip,
              transactionEvents: result.extrinsicEvents,
              extrinsicIndex: index,
            };
          }
        }
      }
    }
  }

  private async getFinalizedBlockNumber(client: ArgonClient): Promise<number> {
    const finalizedHash = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
    return finalizedHeader.number.toNumber();
  }

  private updateProgress(txInfo: ITransactionInfo, finalizedHeight: number, bestBlockNumber: number): void {
    const { tx, progressCallbacks } = txInfo;
    let progress = 10;
    if (tx.blockHeight && !tx.isFinalized) {
      const elapsedBlocks = finalizedHeight - tx.blockHeight;
      const FINALIZATION_BLOCKS = 4;
      const completedPercent = (100 * elapsedBlocks) / FINALIZATION_BLOCKS;
      progress = Math.min(99, completedPercent);
    } else if (tx.submissionErrorJson) {
      progress = 100;
    }
    for (const progressCallback of progressCallbacks) {
      progressCallback({
        submittedBlock: tx.submittedAtBlockHeight,
        includedInBlockNumber: tx.blockHeight,
        bestBlock: bestBlockNumber,
        finalizedBlock: finalizedHeight,
        progress,
      });
    }
  }

  private async updatePendingStatuses(bestBlockNumber: number): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(true);
    const finalizedHeight = await this.getFinalizedBlockNumber(client);
    console.log('Checking for pending transaction statuses', { finalizedHeight, bestBlockNumber });
    for (const info of this.data.transactions) {
      const { tx, txResult } = info;
      if (!PENDING_STATUSES.includes(tx.status)) continue;
      try {
        if (tx.blockHeight && tx.blockHeight <= finalizedHeight) {
          // ensure this block hash is still valid
          const finalizedHash = await client.rpc.chain.getBlockHash(tx.blockHeight);
          if (u8aToHex(finalizedHash) === tx.blockHash) {
            await table.markFinalized(tx);
            txResult.setFinalized();
            continue;
          }
        }

        const MAX_BLOCKS_TO_CHECK = 60;
        if (finalizedHeight - tx.submittedAtBlockHeight > MAX_BLOCKS_TO_CHECK) {
          // too old, stop checking
          console.log('Skipping transaction too old to check:', tx.extrinsicHash);
          txResult.extrinsicError = new Error('Transaction expired waiting for block inclusion');
          txResult.setFinalized();
          await table.markExpiredWaitingForBlock(tx);
          continue;
        }

        const findTransactionResult = await this.findTransaction(tx, client, MAX_BLOCKS_TO_CHECK, bestBlockNumber);
        if (findTransactionResult) {
          const originalBlockHash = tx.blockHash;
          if (originalBlockHash === findTransactionResult.blockHash) {
            // no change
            continue;
          }
          const { blockHash, blockNumber, txFeePlusTip, tip, extrinsicError, transactionEvents, extrinsicIndex } =
            findTransactionResult;
          const api = await client.at(findTransactionResult.blockHash);
          const blockTime = (await api.query.timestamp.now()).toNumber();
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
        }
      } catch (error) {
        console.error('Error updating pending transaction status:', error);
      } finally {
        this.updateProgress(info, finalizedHeight, bestBlockNumber);
      }
    }
    if (this.data.transactions.every(x => !PENDING_STATUSES.includes(x.tx.status))) {
      this.stopWatching();
    }
  }

  private async getTable(): Promise<TransactionsTable> {
    this.#table ??= await this.dbPromise.then(x => x.transactionsTable);
    return this.#table;
  }

  private async getBlock(client: ArgonClient, blockHash: Uint8Array): Promise<SignedBlock> {
    const cacheKey = u8aToHex(blockHash);
    const cached = this.#blockCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const block = await client.rpc.chain.getBlock(blockHash);
    this.#blockCache.set(cacheKey, block);
    return block;
  }
}
