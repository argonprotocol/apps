import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { addressBytesHex } from '@argonprotocol/bitcoin';
import { formatArgons } from '@argonprotocol/mainchain';
import { nanoid } from 'nanoid';

import BitcoinLocks from '../BitcoinLocks.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../../interfaces/IBitcoinReleaseRecord.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLockReleaseInput {
  lockId: number;
  bitcoinNetworkFee: bigint;
  toScriptPubkey: string;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLockReleaseMetadata {
  releaseId: string;
  lockId: number;
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
}

type BitcoinLockReleaseBuild = TransactionOperationBuild<IBitcoinLockReleaseMetadata> & {
  lock: IBitcoinLockRecord;
};

export class BitcoinLockRelease extends TransactionOperation<
  BitcoinLockReleaseInput,
  IBitcoinLockReleaseMetadata,
  BitcoinLockReleaseBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinRequestRelease;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  protected async build(args: BitcoinLockReleaseInput): Promise<BitcoinLockReleaseBuild> {
    const { lockId, bitcoinNetworkFee, toScriptPubkey, txSigner, tip, client: providedClient } = args;
    const lock = this.bitcoinLocks.getLockById(lockId);
    if (!lock) throw new Error(`No Bitcoin lock found with ID ${lockId}`);
    const activeRelease = this.bitcoinLocks.releases.getActiveForLock(lock);
    if (
      !this.bitcoinLocks.isLockFunded(lock) &&
      activeRelease?.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon
    ) {
      throw new Error('This Bitcoin lock is not funded, so it cannot be released.');
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const bitcoinLock = await BitcoinLock.get(client, lockId);
    if (!bitcoinLock) throw new Error(`Lock with ID ${lockId} is unavailable from current chain state.`);
    if (bitcoinLock.fissionedSatoshis > 0n) {
      throw new Error('Close its Liquid before releasing this Bitcoin lock.');
    }

    const destinationScript = addressBytesHex(toScriptPubkey, this.bitcoinLocks.bitcoinNetwork);
    if (
      activeRelease &&
      (activeRelease.toScriptPubkey !== destinationScript || activeRelease.bitcoinNetworkFee !== bitcoinNetworkFee)
    ) {
      throw new Error(`Bitcoin lock ${lockId} already has a different release request`);
    }

    return {
      client,
      lock,
      txs: [
        BitcoinLock.createReleaseTx({
          client,
          lockId,
          toScriptPubkey: destinationScript,
          bitcoinNetworkFee,
        }),
      ],
      txSigner,
      tip,
      metadata: {
        releaseId: activeRelease?.id ?? nanoid(),
        lockId,
        toScriptPubkey,
        bitcoinNetworkFee,
      },
    };
  }

  protected getOperationKey(args: BitcoinLockReleaseInput): string {
    return `${args.txSigner.address}:${args.lockId}`;
  }

  protected matches(args: BitcoinLockReleaseInput, txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): boolean {
    return txInfo.tx.accountAddress === args.txSigner.address && txInfo.tx.metadataJson.lockId === args.lockId;
  }

  public getPendingReleaseTxInfo(lockId: number): TransactionInfo<IBitcoinLockReleaseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.lockId === lockId);
  }

  protected async beforeSubmit(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
  ) {
    const { lock, metadata } = prepared;
    if (!lock.fundingUtxoIds.length) throw new Error(`Bitcoin lock ${metadata.lockId} has no funding UTXOs`);

    await this.bitcoinLocks.releases.createLockRelease(lock, {
      id: metadata.releaseId,
      kind: BitcoinReleaseKind.Lock,
      lockId: metadata.lockId,
      status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      inputUtxoIds: [...lock.fundingUtxoIds],
      toScriptPubkey: addressBytesHex(metadata.toScriptPubkey, this.bitcoinLocks.bitcoinNetwork),
      bitcoinNetworkFee: metadata.bitcoinNetworkFee,
      vaultSignatures: [],
    });
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const lock = this.bitcoinLocks.getLockById(txInfo.tx.metadataJson.lockId);
    if (!lock) return;
    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    await this.bitcoinLocks.releases.finalizeLockRequest(
      lock,
      txInfo.tx.metadataJson.releaseId,
      blockHash,
      txInfo.txResult.finalFee ?? txInfo.tx.txFeePlusTip ?? 0n,
    );
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const release = this.bitcoinLocks.releases.getById(txInfo.tx.metadataJson.releaseId);
    if (release) await this.bitcoinLocks.releases.failRelease(release, 'Argon release request failed');
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
    error: Error,
  ): Promise<void> {
    const release = this.bitcoinLocks.releases.getById(prepared.metadata.releaseId);
    if (release) await this.bitcoinLocks.releases.recordRetryableError(release, error);
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
  ): Error {
    return new Error(
      `Insufficient funds to send Bitcoin. Available: ${formatArgons(prepared.availableBalance)}, Transaction fee: ${formatArgons(prepared.txFeePlusTip)}`,
    );
  }
}
