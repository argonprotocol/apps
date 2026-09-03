import {
  BitcoinLock,
  SATOSHIS_PER_BITCOIN,
  type ArgonClient,
  type Currency,
  type TxSigningAccount,
} from '@argonprotocol/apps-core';
import { addressBytesHex } from '@argonprotocol/bitcoin';
import { formatArgons } from '@argonprotocol/mainchain';

import BitcoinLocks from '../BitcoinLocks.ts';
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
  utxoId: number;
  bitcoinNetworkFee: bigint;
  toScriptPubkey: string;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLockReleaseMetadata {
  utxoId: number;
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
  redemptionAmount: bigint;
}

type BitcoinLockReleaseBuild = TransactionOperationBuild<IBitcoinLockReleaseMetadata>;

export class BitcoinLockRelease extends TransactionOperation<
  BitcoinLockReleaseInput,
  IBitcoinLockReleaseMetadata,
  BitcoinLockReleaseBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinRequestRelease;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    transactionTracker: TransactionTracker,
    private readonly currency: Currency,
  ) {
    super(transactionTracker);
  }

  protected async build(args: BitcoinLockReleaseInput): Promise<BitcoinLockReleaseBuild> {
    const { utxoId, bitcoinNetworkFee, toScriptPubkey, txSigner, tip, client: providedClient } = args;
    const lock = this.bitcoinLocks.getLockByUtxoId(utxoId);
    if (!lock) throw new Error(`No lock found with UTXO ID ${utxoId}`);
    if (!this.bitcoinLocks.isLockFunded(lock)) {
      throw new Error('This Bitcoin lock is not funded, so it cannot be released.');
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const bitcoinLock = await BitcoinLock.get(client, utxoId);
    if (!bitcoinLock) throw new Error(`Lock with ID ${utxoId} is unavailable from current chain state.`);
    if (bitcoinLock.fissionedSatoshis > 0n) {
      throw new Error('Close its Liquid before releasing this Bitcoin lock.');
    }

    const currentTargetValue = this.currency.priceIndex.getSatoshiPriceInTargetMicrogons(bitcoinLock.fundedSatoshis);
    const securitizedTargetValue =
      (bitcoinLock.microgonsAtTargetPerBtc * bitcoinLock.securitizedSatoshis) / SATOSHIS_PER_BITCOIN;
    const redemptionAmount = BitcoinLock.calculateRedemptionAmount(
      this.currency.priceIndex,
      currentTargetValue,
      securitizedTargetValue,
    );

    return {
      client,
      txs: [
        BitcoinLock.createReleaseTx({
          client,
          utxoId,
          toScriptPubkey: addressBytesHex(toScriptPubkey, this.bitcoinLocks.bitcoinNetwork),
          bitcoinNetworkFee,
        }),
      ],
      txSigner,
      tip,
      metadata: {
        utxoId,
        toScriptPubkey,
        bitcoinNetworkFee,
        redemptionAmount,
      },
    };
  }

  protected getOperationKey(args: BitcoinLockReleaseInput): string {
    return `${args.txSigner.address}:${args.utxoId}`;
  }

  protected matches(args: BitcoinLockReleaseInput, txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): boolean {
    return txInfo.tx.accountAddress === args.txSigner.address && txInfo.tx.metadataJson.utxoId === args.utxoId;
  }

  public getPendingReleaseTxInfo(utxoId: number): TransactionInfo<IBitcoinLockReleaseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.utxoId === utxoId);
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const lock = this.bitcoinLocks.getLockByUtxoId(txInfo.tx.metadataJson.utxoId);
    if (lock) await this.bitcoinLocks.publishReleaseSubmission(lock);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const lock = this.bitcoinLocks.getLockByUtxoId(txInfo.tx.metadataJson.utxoId);
    if (!lock) return;
    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    await this.bitcoinLocks.finalizeReleaseRequest(
      lock,
      blockHash,
      txInfo.txResult.finalFee ?? txInfo.tx.txFeePlusTip ?? 0n,
    );
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLockReleaseMetadata>): Promise<void> {
    const lock = this.bitcoinLocks.getLockByUtxoId(txInfo.tx.metadataJson.utxoId);
    if (lock) await this.bitcoinLocks.failReleaseSubmission(lock);
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLockReleaseMetadata, BitcoinLockReleaseBuild>,
  ): Error {
    return new Error(
      `Insufficient funds to send Bitcoin. Available: ${formatArgons(prepared.availableBalance)}, Transaction fee: ${formatArgons(prepared.txFeePlusTip)}`,
    );
  }
}
