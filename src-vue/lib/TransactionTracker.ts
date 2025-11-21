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
import { createDeferred, IDeferred } from './Utils.ts';
import { TransactionEvents } from '@argonprotocol/apps-core';
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

  constructor(private readonly dbPromise: Promise<Db>) {
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
      const client = await getMainchainClient(true);

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
            console.error('Error restoring events for transaction', tx.extrinsicHash, error);
          }
        }

        const isProcessed = createDeferred();
        if (tx.isFinalized || txResult.extrinsicError || txResult.submissionError) {
          txResult.setFinalized();
          isProcessed.resolve();
        }
        // Mark txResult as non-reactive to avoid issues with private fields
        Vue.markRaw(txResult);
        const txInfo = new TransactionInfo({
          tx,
          txResult,
          isProcessed,
        });
        this.data.txInfos.push(txInfo);
        this.data.txInfosByType[tx.extrinsicType] = txInfo;
      }
      if (this.data.txInfos.some(x => PENDING_STATUSES.includes(x.tx.status))) {
        await this.watchForUpdates();
      }
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error restoring transactions', error);
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

    console.log('SUBMITTING TRANSACTION', extrinsicType);
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
    await this.watchForUpdates();

    // Mark txResult as non-reactive to avoid issues with private fields
    Vue.markRaw(txResult);
    const txInfo = new TransactionInfo<T>({ tx: record, txResult, isProcessed: createDeferred() });
    this.data.txInfos.unshift(txInfo);
    this.data.txInfosByType[extrinsicType] = txInfo;
    if (txResult.submissionError) {
      await table.recordSubmissionError(record, txResult.submissionError);
    }

    return txInfo;
  }

  private async watchForUpdates() {
    const client = await getMainchainClient(false);
    this.#bestBlockNumber = (await client.rpc.chain.getHeader()).number.toNumber();
    await this.updatePendingStatuses(this.#bestBlockNumber);

    this.#watchUnsubscribe ??= await client.rpc.chain.subscribeNewHeads(async bestHeader => {
      try {
        const bestBlockNumber = bestHeader.number.toNumber();
        if (bestBlockNumber !== this.#bestBlockNumber) {
          this.#bestBlockNumber = bestBlockNumber;
          await this.updatePendingStatuses(bestBlockNumber);
        }
      } catch (error) {
        console.error('Error watching for transaction updates:', error);
      }
    });
  }

  private stopWatching() {
    this.#watchUnsubscribe?.();
    this.#watchUnsubscribe = undefined;
  }

  private async findTransactionInBlocks(
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
    const { extrinsicHash, submittedAtBlockHeight } = tx;

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
          const api = await client.at(blockHash);
          const events = await api.query.system.events();
          const result = await TransactionEvents.getErrorAndFeeForTransaction({
            client,
            extrinsicIndex: index,
            events,
          });

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

  private async getFinalizedBlockDetails(client: ArgonClient): Promise<{ blockNumber: number; blockTime: Date }> {
    const finalizedHash = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
    const blockNumber = finalizedHeader.number.toNumber();
    const clientAt = await client.at(finalizedHash);
    const blockTime = new Date((await clientAt.query.timestamp.now()).toNumber());
    return {
      blockNumber,
      blockTime,
    };
  }

  private async updatePendingStatuses(bestBlockNumber: number): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(true);
    const finalizedDetails = await this.getFinalizedBlockDetails(client);
    const finalizedHeight = finalizedDetails.blockNumber;

    for (const txInfo of this.data.txInfos) {
      const { tx, txResult } = txInfo;
      if (!PENDING_STATUSES.includes(tx.status)) {
        continue;
      }
      try {
        if (tx.blockHeight && tx.blockHeight <= finalizedHeight) {
          // ensure this block hash is still valid
          const finalizedHash = await client.rpc.chain.getBlockHash(tx.blockHeight).catch(() => null);
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

        const findTransactionResult = await this.findTransactionInBlocks(
          tx,
          client,
          MAX_BLOCKS_TO_CHECK,
          bestBlockNumber,
        );
        if (findTransactionResult) {
          const originalBlockHash = tx.blockHash;
          if (originalBlockHash === findTransactionResult.blockHash) {
            // no change
            console.log('No change in block', { info: txInfo, findTransactionResult });
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
        } else {
          console.log('No transaction found in block', { bestBlockNumber });
        }
      } catch (error) {
        console.error('Error updating pending transaction status:', error);
      }
    }
    for (const txInfo of this.data.txInfos) {
      if (txInfo.tx.status === TransactionStatus.Finalized || txInfo.tx.status === TransactionStatus.Error) continue;
      await table.updateLastFinalizedBlock(txInfo.tx, finalizedDetails);
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
