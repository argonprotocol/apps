import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { addressBytesHex, type IBitcoinReleaseRequest } from '@argonprotocol/bitcoin';
import { formatArgons } from '@argonprotocol/mainchain';

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
  sendId?: string;
  destinationSatoshis: bigint;
  bitcoinNetworkFee: bigint;
  toScriptPubkey: string;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLockReleaseMetadata extends IBitcoinReleaseRequest {
  releaseId: string;
  sendId: string;
  lockId: number;
  releaseNumber: number;
  inputUtxoIds: number[];
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
    const {
      lockId,
      sendId,
      destinationSatoshis,
      bitcoinNetworkFee,
      toScriptPubkey,
      txSigner,
      tip,
      client: providedClient,
    } = args;
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
    const changeSatoshis = bitcoinLock.fundedSatoshis - destinationSatoshis - bitcoinNetworkFee;
    if (destinationSatoshis <= 0n || bitcoinNetworkFee < 0n || changeSatoshis < 0n) {
      throw new Error('The Bitcoin destination amount and fee exceed the funded Lock or are invalid.');
    }
    if (changeSatoshis === 0n && bitcoinLock.fissionedSatoshis > 0n) {
      throw new Error('Close its Liquid before releasing this Bitcoin lock.');
    }
    if (changeSatoshis > 0n) {
      const minimumSatoshis = await client.query.bitcoinLocks.minimumSatoshis();
      if (minimumSatoshis === null) throw new Error('The runtime minimum Bitcoin amount is unavailable.');
      if (changeSatoshis < minimumSatoshis || changeSatoshis < bitcoinLock.fissionedSatoshis) {
        throw new Error('The retained Bitcoin must cover the runtime minimum and its open Liquid.');
      }
    }

    const inputUtxoIds = bitcoinLock.fundingUtxos.map(input => {
      const utxo = this.bitcoinLocks.utxoTracking.getUtxoRecord(lockId, input.utxoRef.txid, input.utxoRef.vout);
      if (!utxo || utxo.satoshis !== input.satoshis)
        throw new Error(`Bitcoin lock ${lockId} is missing a runtime funding input`);
      return utxo.id;
    });
    if (
      !inputUtxoIds.length ||
      inputUtxoIds.length !== lock.fundingUtxoIds.length ||
      inputUtxoIds.some((id, index) => id !== lock.fundingUtxoIds[index])
    ) {
      throw new Error(`Bitcoin lock ${lockId} no longer matches its runtime funding inputs`);
    }

    const destinationScript = addressBytesHex(toScriptPubkey, this.bitcoinLocks.bitcoinNetwork);
    const previousCosign = await client.query.bitcoinLocks.lockReleaseCosignHeightById(lockId);
    if (typeof previousCosign === 'number') {
      throw new Error('The current runtime did not return a Bitcoin release number.');
    }
    const previousReleaseNumber = previousCosign?.releaseNumber ?? 0;
    const releaseNumber = activeRelease?.releaseNumber ?? previousReleaseNumber + 1;

    const releaseId = `lock:${lockId}:${releaseNumber}`;
    return {
      client,
      lock,
      txs: [
        BitcoinLock.createReleaseTx({
          client,
          lockId,
          toScriptPubkey: destinationScript,
          bitcoinNetworkFee,
          destinationSatoshis,
        }),
      ],
      txSigner,
      tip,
      metadata: {
        releaseId,
        sendId: sendId ?? releaseId,
        releaseNumber,
        lockId,
        inputUtxoIds,
        destinationSatoshis,
        changeSatoshis,
        toScriptPubkey: destinationScript,
        bitcoinNetworkFee,
      },
    };
  }

  protected getOperationKey(args: BitcoinLockReleaseInput): string {
    return `${args.txSigner.address}:${args.lockId}:${args.destinationSatoshis}:${args.bitcoinNetworkFee}:${args.toScriptPubkey}`;
  }

  protected matches(args: BitcoinLockReleaseInput, txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): boolean {
    const lock = this.bitcoinLocks.getLockById(args.lockId);
    const activeRelease = lock && this.bitcoinLocks.releases.getActiveForLock(lock);
    const metadata = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === args.txSigner.address &&
      metadata.lockId === args.lockId &&
      activeRelease?.releaseNumber === metadata.releaseNumber &&
      activeRelease?.id === metadata.releaseId &&
      metadata.sendId === (args.sendId ?? metadata.releaseId) &&
      metadata.destinationSatoshis === args.destinationSatoshis &&
      metadata.bitcoinNetworkFee === args.bitcoinNetworkFee &&
      metadata.toScriptPubkey === addressBytesHex(args.toScriptPubkey, this.bitcoinLocks.bitcoinNetwork)
    );
  }

  public getPendingReleaseTxInfo(lockId: number): TransactionInfo<IBitcoinLockReleaseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.lockId === lockId);
  }

  protected async beforeSubmit(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
  ) {
    const { lock, metadata } = prepared;
    if (!lock.fundingUtxoIds.length) throw new Error(`Bitcoin lock ${metadata.lockId} has no funding UTXOs`);

    await this.bitcoinLocks.runInQueueForLock(lock, async () => {
      await this.bitcoinLocks.releases.createLockRelease(lock, {
        id: metadata.releaseId,
        sendId: metadata.sendId,
        kind: BitcoinReleaseKind.Lock,
        lockId: metadata.lockId,
        releaseNumber: metadata.releaseNumber,
        destinationSatoshis: metadata.destinationSatoshis,
        changeSatoshis: metadata.changeSatoshis,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [...metadata.inputUtxoIds],
        toScriptPubkey: metadata.toScriptPubkey,
        bitcoinNetworkFee: metadata.bitcoinNetworkFee,
        vaultSignatures: [],
      });
    });
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockById(metadata.lockId);
    if (!lock) return;

    await this.transactionTracker.ensureStoredEvents(txInfo);
    const requestEvent = txInfo.txResult.events.find(event => {
      return (
        event.section === 'bitcoinLocks' &&
        event.method === 'BitcoinUtxoCosignRequested' &&
        event.data.lockId === metadata.lockId &&
        event.data.releaseNumber === metadata.releaseNumber
      );
    });
    if (!requestEvent) {
      throw new Error(`Bitcoin release ${metadata.releaseId} finalized without its request event`);
    }

    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    const client = await getMainchainClient(true);
    const api = await client.at(blockHash);
    const [request, currentLock, currentTick] = await Promise.all([
      BitcoinLock.getReleaseRequest(api, metadata.lockId),
      BitcoinLock.get(api, metadata.lockId),
      api.query.ticks.currentTick(),
    ]);
    if (!request || !currentLock || currentTick === null) {
      throw new Error(`Bitcoin release ${metadata.releaseId} is missing finalized chain state`);
    }

    const inputUtxoIds = currentLock.fundingUtxos.map(input => {
      const utxo = this.bitcoinLocks.utxoTracking.getUtxoRecord(
        metadata.lockId,
        input.utxoRef.txid,
        input.utxoRef.vout,
      );
      if (!utxo || utxo.satoshis !== input.satoshis) {
        throw new Error(`Bitcoin release ${metadata.releaseId} is missing a finalized funding input`);
      }
      return utxo.id;
    });

    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        await this.bitcoinLocks.releases.finalizeLockRequest(lock, {
          releaseId: metadata.releaseId,
          request,
          inputUtxoIds,
          requestedReleaseAtTick: Number(currentTick),
          argonTxFeeMicrogons: txInfo.txResult.finalFee ?? txInfo.tx.txFeePlusTip ?? 0n,
        });
      },
      { skipActionAvailability: true },
    );
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const metadata = txInfo.tx.metadataJson;
    const lock = this.bitcoinLocks.getLockById(metadata.lockId);
    if (!lock) return;
    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        const release = this.bitcoinLocks.releases.getById(metadata.releaseId);
        if (release) await this.bitcoinLocks.releases.failRelease(release, 'Argon release request failed');
      },
      { skipActionAvailability: true },
    );
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
    error: Error,
  ): Promise<void> {
    const { lock, metadata } = prepared;
    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        const release = this.bitcoinLocks.releases.getById(metadata.releaseId);
        if (release) await this.bitcoinLocks.releases.recordRetryableError(release, error);
      },
      { skipActionAvailability: true },
    );
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
  ): Error {
    return new Error(
      `Insufficient funds to send Bitcoin. Available: ${formatArgons(prepared.availableBalance)}, Transaction fee: ${formatArgons(prepared.txFeePlusTip)}`,
    );
  }
}
