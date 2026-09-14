import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { addressBytesHex } from '@argonprotocol/bitcoin';
import { hexToU8a } from '@argonprotocol/mainchain';
import { nanoid } from 'nanoid';

import { getMainchainClient } from '../../stores/mainchain.ts';
import type BitcoinLocks from '../BitcoinLocks.ts';
import type { IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../../interfaces/IBitcoinReleaseRecord.ts';
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
  releaseId: string;
  releaseKind: 'Orphan';
  lockId: number;
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
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public override async submit(
    input: BitcoinOrphanReleaseInput,
    prepared?: PreparedTransactionOperation<IBitcoinOrphanReleaseMetadata, BitcoinOrphanReleaseBuild>,
  ): Promise<TransactionInfo<IBitcoinOrphanReleaseMetadata>> {
    const lock = input.lock.lockId ? this.bitcoinLocks.getLockById(input.lock.lockId) : undefined;
    if (!lock) throw new Error('The Bitcoin lock for this orphan is unavailable.');
    this.bitcoinLocks.ensureBitcoinActionsAvailable(lock, { allowOrphanRecovery: true });

    return await super.submit({ ...input, lock }, prepared);
  }

  protected async build(input: BitcoinOrphanReleaseInput): Promise<BitcoinOrphanReleaseBuild> {
    const { lock, toScriptPubkey, bitcoinNetworkFee: providedNetworkFee, feeRatePerSatVb, txSigner, tip } = input;
    const record = this.bitcoinLocks.utxoTracking.getUtxoRecord(
      input.record.lockId,
      input.record.txid,
      input.record.vout,
    );
    if (!lock.lockId || !record || record.lockId !== lock.lockId) {
      throw new Error('This orphan does not belong to the selected Bitcoin lock.');
    }
    const activeRelease = this.bitcoinLocks.releases.getActiveForUtxo(record);
    if (activeRelease && activeRelease.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon) {
      throw new Error('This orphan return is already in progress.');
    }
    if (record.status !== BitcoinUtxoStatus.Orphaned || record.spendStatus === BitcoinUtxoSpendStatus.Spent) {
      throw new Error('This orphan return is not currently available.');
    }

    const client = input.client ?? (await getMainchainClient(false));
    const destinationScript = addressBytesHex(toScriptPubkey, this.bitcoinLocks.bitcoinNetwork);
    const bitcoinNetworkFee =
      providedNetworkFee ??
      this.bitcoinLocks
        .createCosignScript({ lock, fundedSatoshis: record.satoshis })
        .calculateFee(feeRatePerSatVb ?? 5n, 1, destinationScript);
    if (
      activeRelease &&
      (activeRelease.toScriptPubkey !== destinationScript || activeRelease.bitcoinNetworkFee !== bitcoinNetworkFee)
    ) {
      throw new Error(`Bitcoin UTXO ${record.id} already has a different release request`);
    }

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
        releaseId: activeRelease?.id ?? nanoid(),
        releaseKind: 'Orphan',
        lockId: lock.lockId,
        utxoRecordId: record.id,
        utxoRef: { txid: record.txid, vout: record.vout },
        toScriptPubkey,
        bitcoinNetworkFee,
      },
    };
  }

  protected getOperationKey(input: BitcoinOrphanReleaseInput): string {
    return `${input.txSigner.address}:${input.record.lockId}:${input.record.txid}:${input.record.vout}`;
  }

  protected matches(input: BitcoinOrphanReleaseInput, txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>): boolean {
    const metadata = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === input.txSigner.address &&
      metadata.lockId === input.record.lockId &&
      metadata.utxoRecordId === input.record.id
    );
  }

  public getPendingReleaseTxInfo(
    lockId: number,
    record: Pick<IBitcoinUtxoRecord, 'id'>,
  ): TransactionInfo<IBitcoinOrphanReleaseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => {
      return txInfo.tx.metadataJson.lockId === lockId && txInfo.tx.metadataJson.utxoRecordId === record.id;
    });
  }

  protected async beforeSubmit(
    prepared: PreparedTransactionOperation<IBitcoinOrphanReleaseMetadata, BitcoinOrphanReleaseBuild>,
  ): Promise<void> {
    const metadata = prepared.metadata;
    const record = this.bitcoinLocks.utxoTracking.getUtxoRecordById(metadata.utxoRecordId);
    if (!record) throw new Error(`Bitcoin UTXO ${metadata.utxoRecordId} is unavailable`);
    if (metadata.toScriptPubkey === undefined || metadata.bitcoinNetworkFee === undefined) {
      throw new Error(`Bitcoin release ${metadata.releaseId} is missing its return request`);
    }

    await this.bitcoinLocks.releases.createOrphanRelease(record, {
      id: metadata.releaseId,
      kind: BitcoinReleaseKind.Orphan,
      lockId: metadata.lockId,
      status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      inputUtxoIds: [metadata.utxoRecordId],
      toScriptPubkey: addressBytesHex(metadata.toScriptPubkey, this.bitcoinLocks.bitcoinNetwork),
      bitcoinNetworkFee: metadata.bitcoinNetworkFee,
      vaultSignatures: [],
    });
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinOrphanReleaseMetadata>): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockById(metadata.lockId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        const record = this.bitcoinLocks.utxoTracking.getUtxoRecordById(metadata.utxoRecordId);
        if (!record) return;
        const release = this.bitcoinLocks.releases.getById(metadata.releaseId);
        if (!release || record.activeReleaseId !== release.id) return;
        const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
        await this.bitcoinLocks.releases.finalizeOrphanRequest(
          release,
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
    const lock = this.bitcoinLocks.getLockById(metadata.lockId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        const release = this.bitcoinLocks.releases.getById(metadata.releaseId);
        if (release) await this.bitcoinLocks.releases.failRelease(release, error);
      },
      {
        waitForHistoryRecovery: true,
      },
    );
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinOrphanReleaseMetadata, BitcoinOrphanReleaseBuild>,
    error: Error,
  ): Promise<void> {
    const release = this.bitcoinLocks.releases.getById(prepared.metadata.releaseId);
    if (release) await this.bitcoinLocks.releases.recordRetryableError(release, error);
  }

  protected createInsufficientFundsError(
    _prepared: PreparedTransactionOperation<IBitcoinOrphanReleaseMetadata, BitcoinOrphanReleaseBuild>,
  ): Error {
    return new Error('The Internal App Wallet does not have enough ARGON to cover the transaction fee.');
  }
}
