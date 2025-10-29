import {
  ArgonClient,
  ExtrinsicError,
  GenericEvent,
  Header,
  hexToU8a,
  ITxProgressCallback,
  KeyringPair,
  SignedBlock,
  SubmittableExtrinsic,
  TxResult,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createDeferred, IDeferred } from './Utils.ts';
import { TransactionFees } from '@argonprotocol/apps-core';
import { ExtrinsicType, ITransactionRecord, TransactionsTable, TransactionStatus } from './db/TransactionsTable.ts';
import { LRU } from 'tiny-lru';

const PENDING_STATUSES = [TransactionStatus.Submitted, TransactionStatus.InBlock];
export class TransactionTracker {
  public data: {
    transactions: {
      tx: ITransactionRecord;
      txResult: TxResultExtension;
      statusAtLoad?: TransactionStatus;
    }[];
  };

  #waitForLoad?: IDeferred;
  #table?: TransactionsTable;
  #blockCache = new LRU<SignedBlock>(25);
  #watchUnsubscribe?: () => void;

  constructor(readonly dbPromise: Promise<Db>) {
    this.data = {
      transactions: [],
    };
  }

  public get pendingBlockTransactionsAtLoad(): { tx: ITransactionRecord; txResult: TxResultExtension }[] {
    return this.data.transactions
      .filter(x => x.statusAtLoad === TransactionStatus.Submitted)
      .map(x => ({ tx: x.tx, txResult: x.txResult }));
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad ??= createDeferred();
    try {
      const table = await this.getTable();
      const txs = await table.fetchAll();
      const client = await getMainchainClient(false);
      this.data.transactions.length = 0;
      for (const tx of txs) {
        const txResult = new TxResultExtension(client);
        if (tx.isFinalized) txResult.resolveFinalized(hexToU8a(tx.includedInBlockHash));
        if (tx.includedInBlockHash) {
          txResult.includedInBlock = hexToU8a(tx.includedInBlockHash);
          txResult.finalFee = tx.txFeePlusTip ?? 0n;
          txResult.finalFeeTip = tx.txTip ?? 0n;
          if (tx.extrinsicErrorJson) {
            txResult.rejectInBlock(
              new ExtrinsicError(
                tx.extrinsicErrorJson.errorCode ?? 'Unknown Error',
                tx.extrinsicErrorJson.details ?? tx.extrinsicErrorJson.message,
                tx.extrinsicErrorJson.batchInterruptedIndex,
              ),
            );
          } else {
            txResult.resolveInBlock(txResult.includedInBlock);
          }
        }
        txResult.submissionError = tx.submissionErrorJson ? new Error(tx.submissionErrorJson.message) : undefined;
        this.data.transactions.push({
          tx,
          txResult,
          statusAtLoad: tx.status,
        });
      }
      if (this.data.transactions.some(x => PENDING_STATUSES.includes(x.tx.status))) {
        await this.watchForUpdates();
      }
      this.#waitForLoad.resolve();
    } catch (error) {
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async submitAndWatch(args: {
    tx: SubmittableExtrinsic;
    signer: KeyringPair;
    tip?: bigint;
    extrinsicType: ExtrinsicType;
    extrinsicMetadata?: any;
    useLatestNonce?: boolean;
    txProgressCallback?: ITxProgressCallback;
  }): Promise<{ txResult: TxResultExtension; tx: ITransactionRecord }> {
    await this.load();
    const { tx, signer, extrinsicType, extrinsicMetadata, txProgressCallback, tip } = args;
    const client = await getMainchainClient(false);
    const table = await this.getTable();
    let nonce: number | undefined;
    if (args.useLatestNonce) {
      const { nonce: nonceRaw } = await client.query.system.account(args.signer.address);
      nonce = nonceRaw.toNumber();
    }

    const signedTx = await tx.signAsync(signer, {
      nonce,
      tip,
    });
    const extrinsicHash = u8aToHex(signedTx.hash);
    const extrinsicJson = signedTx.method.toHuman();
    const accountAddress = signer.address;
    const submittedAtBlockHash = await client.rpc.chain.getBlockHash();
    const submittedAtHeader = await client.rpc.chain.getHeader(submittedAtBlockHash);
    const submittedAtBlockHeight = submittedAtHeader.number.toNumber();
    const submittedAtTime = new Date();
    const record = await table.insert({
      extrinsicHash,
      extrinsicJson,
      extrinsicMetadata,
      extrinsicType,
      accountAddress,
      submittedAtBlockHeight,
      submittedAtTime,
    });
    await this.watchForUpdates();

    const txResult = new TxResultExtension(client);
    txResult.txProgressCallback = txProgressCallback;
    this.data.transactions.unshift({ tx: record, txResult });
    try {
      await tx.send();
      txResult.isSubmitted = true;
    } catch (error) {
      console.error('RPC Error submitting transaction:', error);
      txResult.submissionError = error as Error;
      txResult.rejectInBlock(error as Error);
      await table.recordSubmissionError(record, error as Error);
    }

    return { txResult, tx: record };
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
        blockHeight: number;
        blockHash: string;
        extrinsicError?: ExtrinsicError;
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
              blockHeight,
              blockHash: u8aToHex(blockHash),
              extrinsicError: result.error,
              txFeePlusTip: result.fee + result.tip,
              tip: result.tip,
              transactionEvents: result.extrinsicEvents,
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

  private async updatePendingStatuses(bestBlockNumber: number): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(true);
    const finalizedHeight = await this.getFinalizedBlockNumber(client);
    console.log('Checking for pending transaction statuses', { finalizedHeight, bestBlockNumber });
    for (const { tx, txResult } of this.data.transactions) {
      if (!PENDING_STATUSES.includes(tx.status)) continue;

      try {
        if (tx.includedInBlockHeight && tx.includedInBlockHeight < finalizedHeight) {
          // ensure this block hash is still valid
          const finalizedHash = await client.rpc.chain.getBlockHash(tx.includedInBlockHeight);
          if (u8aToHex(finalizedHash) === tx.includedInBlockHash) {
            await table.markFinalized(tx);
            txResult.resolveFinalized(Uint8Array.from(finalizedHash));
            continue;
          }
        }

        const MAX_BLOCKS_TO_CHECK = 60;
        if (finalizedHeight - tx.submittedAtBlockHeight > MAX_BLOCKS_TO_CHECK) {
          // too old, stop checking
          console.log('Skipping transaction too old to check:', tx.extrinsicHash);
          txResult.rejectInBlock(new Error('Transaction expired waiting for block inclusion'));
          await table.markExpiredWaitingForBlock(tx);
          continue;
        }

        const findTransactionResult = await this.findTransaction(tx, client, MAX_BLOCKS_TO_CHECK, bestBlockNumber);
        if (findTransactionResult) {
          const originalBlockHash = tx.includedInBlockHash;
          if (originalBlockHash === findTransactionResult.blockHash) {
            // no change
            continue;
          }
          const { blockHash, blockHeight, txFeePlusTip, tip, extrinsicError, transactionEvents } =
            findTransactionResult;
          const api = await client.at(findTransactionResult.blockHash);
          const blockTime = (await api.query.timestamp.now()).toNumber();
          const u8aBlockHash = hexToU8a(blockHash);
          await table.recordInBlock(tx, {
            blockNumber: blockHeight,
            blockHash,
            blockTime: new Date(blockTime),
            feePlusTip: txFeePlusTip,
            tip: tip,
            extrinsicError,
            transactionEvents,
          });
          txResult.finalFee = txFeePlusTip - tip;
          txResult.finalFeeTip = tip;
          txResult.events.length = 0;
          txResult.events.push(...transactionEvents);
          txResult.includedInBlock = u8aBlockHash;
          if (extrinsicError) {
            txResult.rejectInBlock(extrinsicError);
          } else {
            txResult.resolveInBlock(u8aBlockHash);
          }

          if (findTransactionResult.blockHeight < finalizedHeight) {
            await table.markFinalized(tx);
            txResult.resolveFinalized(u8aBlockHash);
          }
        }
      } catch (error) {
        console.error('Error updating pending transaction status:', error);
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

export class TxResultExtension extends TxResult {
  #isSubmitted = false;
  #submissionError?: Error;

  set isSubmitted(value: boolean) {
    this.#isSubmitted = value;
    this.updateProgress();
  }

  get isSubmitted(): boolean {
    return this.#isSubmitted;
  }

  set submissionError(value: Error | undefined) {
    this.#submissionError = value;
    this.updateProgress();
  }

  get submissionError(): Error | undefined {
    return this.#submissionError;
  }

  resolveInBlock!: (blockHash: Uint8Array) => void;
  rejectInBlock!: (error: ExtrinsicError | Error) => void;
  resolveFinalized!: (blockHash: Uint8Array) => void;
  rejectFinalized!: (error: ExtrinsicError) => void;

  get error(): Promise<Error | ExtrinsicError | undefined> {
    if (this.submissionError) {
      return Promise.resolve(this.submissionError);
    }
    return this.finalizedPromise
      .then(() => undefined)
      .catch(err => {
        if (err instanceof Error) {
          return err;
        }
      });
  }

  constructor(client: ArgonClient) {
    super(client);

    this.inBlockPromise = new Promise((resolve, reject) => {
      this.resolveInBlock = resolve;
      this.rejectInBlock = reject;
    });
    this.finalizedPromise = new Promise((resolve, reject) => {
      this.resolveFinalized = resolve;
      this.rejectFinalized = reject;
    });
    // drown unhandled
    this.inBlockPromise
      .then(hash => {
        this.includedInBlock = hash;
        this.isSubmitted = true;
        this.updateProgress();
      })
      .catch(() => {
        this.updateProgress();
      });
    this.finalizedPromise
      .then(hash => {
        this.resolveInBlock(hash);
        this.updateProgress();
      })
      .catch(err => {
        this.rejectInBlock(err);
        this.updateProgress();
      });
  }

  private updateProgress() {
    if (this.txProgressCallback) {
      let percent = 0;
      if (this.isSubmitted) {
        percent = 20;
      }
      if (this.includedInBlock || this.submissionError) {
        percent = 100;
      }

      this.txProgressCallback(percent, this);
    }
  }
}
