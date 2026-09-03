import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { addressBytesHex } from '@argonprotocol/bitcoin';
import { hexToU8a } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import type BitcoinLocks from '../BitcoinLocks.ts';
import type BitcoinOrphanReleases from '../BitcoinOrphanReleases.ts';
import type { IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { BitcoinUtxoRole, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinOrphanReleaseInput {
  lock: IBitcoinLockRecord;
  record: IBitcoinUtxoRecord;
  toScriptPubkey: string;
  bitcoinNetworkFee?: bigint;
  feeRatePerSatVb?: bigint;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinOrphanReleaseMetadata {
  releaseKind: 'Orphan';
  utxoId: number;
  utxoRecordId: number;
  utxoRef: { txid: string; vout: number };
  // Transactions persisted before release extraction stored these details on the UTXO record only.
  toScriptPubkey?: string;
  bitcoinNetworkFee?: bigint;
}

type BitcoinOrphanReleaseBuild = TransactionOperationBuild<IBitcoinOrphanReleaseMetadata>;

export class BitcoinOrphanRelease extends TransactionOperation<
  BitcoinOrphanReleaseInput,
  IBitcoinOrphanReleaseMetadata,
  BitcoinOrphanReleaseBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinOrphanedUtxoRelease;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly orphanReleases: BitcoinOrphanReleases,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public override async submit(
    input: BitcoinOrphanReleaseInput,
  ): Promise<TransactionInfo<IBitcoinOrphanReleaseMetadata>> {
    const lock = input.lock.utxoId ? this.bitcoinLocks.getLockByUtxoId(input.lock.utxoId) : undefined;
    if (!lock) throw new Error('The Bitcoin lock for this orphan is unavailable.');
    this.bitcoinLocks.ensureBitcoinActionsAvailable(lock, { allowOrphanRecovery: true });

    return await super.submit({ ...input, lock });
  }

  protected async build(input: BitcoinOrphanReleaseInput): Promise<BitcoinOrphanReleaseBuild> {
    const { lock, toScriptPubkey, bitcoinNetworkFee: providedNetworkFee, feeRatePerSatVb, txSigner, tip } = input;
    const record = this.bitcoinLocks.utxoTracking.getUtxoRecord(
      input.record.lockUtxoId,
      input.record.txid,
      input.record.vout,
    );
    if (!lock.utxoId || !record || record.lockUtxoId !== lock.utxoId) {
      throw new Error('This orphan does not belong to the selected Bitcoin lock.');
    }
    if (this.bitcoinLocks.utxoTracking.isReleaseStatus(record.status)) {
      throw new Error('This orphan return is already in progress.');
    }
    if (record.role !== BitcoinUtxoRole.Orphan) {
      throw new Error('This orphan return is not currently available.');
    }

    const client = input.client ?? (await getMainchainClient(false));
    const destinationScript = addressBytesHex(toScriptPubkey, this.bitcoinLocks.bitcoinNetwork);
    const bitcoinNetworkFee =
      providedNetworkFee ??
      (await this.bitcoinLocks.calculateBitcoinNetworkFee(lock, feeRatePerSatVb ?? 5n, toScriptPubkey));

    return {
      client,
      txs: [
        BitcoinLock.createOrphanedReleaseTx({
          client,
          utxoRef: { txid: record.txid, outputIndex: record.vout },
          toScriptPubkey: destinationScript,
          bitcoinNetworkFee,
        }),
      ],
      txSigner,
      tip,
      metadata: {
        releaseKind: 'Orphan',
        utxoId: lock.utxoId,
        utxoRecordId: record.id,
        utxoRef: { txid: record.txid, vout: record.vout },
        toScriptPubkey: destinationScript,
        bitcoinNetworkFee,
      },
    };
  }

  protected getOperationKey(input: BitcoinOrphanReleaseInput): string {
    return `${input.txSigner.address}:${input.record.lockUtxoId}:${input.record.txid}:${input.record.vout}`;
  }

  protected matches(input: BitcoinOrphanReleaseInput, txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>): boolean {
    const metadata = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === input.txSigner.address &&
      metadata.utxoId === input.record.lockUtxoId &&
      metadata.utxoRecordId === input.record.id
    );
  }

  public getPendingReleaseTxInfo(
    utxoId: number,
    record: Pick<IBitcoinUtxoRecord, 'id'>,
  ): TransactionInfo<IBitcoinOrphanReleaseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => {
      return txInfo.tx.metadataJson.utxoId === utxoId && txInfo.tx.metadataJson.utxoRecordId === record.id;
    });
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockByUtxoId(metadata.utxoId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForUtxo(
      lock,
      async () => {
        const record = this.bitcoinLocks.utxoTracking.getUtxoRecordById(metadata.utxoRecordId);
        if (!record) return;
        const toScriptPubkey = metadata.toScriptPubkey ?? record.releaseToDestinationAddress;
        const bitcoinNetworkFee = metadata.bitcoinNetworkFee ?? record.releaseBitcoinNetworkFee;
        if (!toScriptPubkey || bitcoinNetworkFee == null) return;
        await this.orphanReleases.publishReleaseSubmission(record, {
          toScriptPubkey,
          bitcoinNetworkFee,
        });
      },
      {
        waitForHistoryRecovery: true,
      },
    );
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockByUtxoId(metadata.utxoId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForUtxo(
      lock,
      async () => {
        const record = this.bitcoinLocks.utxoTracking.getUtxoRecordById(metadata.utxoRecordId);
        if (!record) return;
        const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
        await this.orphanReleases.recordReleaseRequest(
          record,
          typeof blockHash === 'string' ? hexToU8a(blockHash) : blockHash,
        );
      },
      {
        waitForHistoryRecovery: true,
      },
    );
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>, error: Error): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockByUtxoId(metadata.utxoId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForUtxo(
      lock,
      async () => {
        const record = this.bitcoinLocks.utxoTracking.getUtxoRecordById(metadata.utxoRecordId);
        if (record) await this.orphanReleases.failReleaseRequest(record, error);
      },
      {
        waitForHistoryRecovery: true,
      },
    );
  }

  protected createInsufficientFundsError(
    _prepared: PreparedTransactionOperation<IBitcoinOrphanReleaseMetadata, BitcoinOrphanReleaseBuild>,
  ): Error {
    return new Error('The Internal App Wallet does not have enough ARGON to cover the transaction fee.');
  }
}
