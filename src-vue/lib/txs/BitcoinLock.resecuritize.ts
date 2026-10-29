import { getHistoricalBitcoinLockDetails } from '../recovery/BitcoinLockHistory.ts';
import {
  bigIntMax,
  bigIntMin,
  BitcoinLock,
  type BitcoinLockFeeCoupon,
  type IBitcoinLockCouponRequest,
  type Currency,
  type IBitcoinLockCouponStatus,
  type ArgonClient,
  type TxSigningAccount,
  Vault,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import BitcoinLocks, { BitcoinLockWalletFundingError } from '../BitcoinLocks.ts';
import { BitcoinLocksTable, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLockResecuritizeInput {
  lock: IBitcoinLockRecord;
  vault: Vault;
  securitizedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  txSigner: TxSigningAccount;
  tip?: bigint;
  operatorCoupon?: IBitcoinLockCouponStatus;
  client?: ArgonClient;
  priceIndex?: PriceIndex;
  currentBitcoinHeight?: number;
  currentCoverageMicrogons?: bigint;
  maximumFeeCreditMicrogons?: bigint;
}

export interface IBitcoinResecuritizationMetadata {
  bitcoin: {
    lockId: number;
    vaultId: number;
    securitizedSatoshis: bigint;
    microgonsAtTargetPerBtc: bigint;
    securityFee: bigint;
    feeCouponNonce?: bigint;
    feeCouponRequestId?: string;
  };
}

type BitcoinLockResecuritizeBuild = TransactionOperationBuild<IBitcoinResecuritizationMetadata> & {
  feeCouponRequestId?: string;
  replacementCoverageMicrogons: bigint;
  totalSecurityFee: bigint;
  securityFee: bigint;
};

export class BitcoinLockResecuritize extends TransactionOperation<
  BitcoinLockResecuritizeInput,
  IBitcoinResecuritizationMetadata,
  BitcoinLockResecuritizeBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinResecuritize;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    transactionTracker: TransactionTracker,
    private readonly currency: Currency,
    private readonly upstreamOperatorClient: UpstreamOperatorClient,
  ) {
    super(transactionTracker);
  }

  protected async build(args: BitcoinLockResecuritizeInput): Promise<BitcoinLockResecuritizeBuild> {
    const {
      lock,
      vault,
      securitizedSatoshis,
      microgonsAtTargetPerBtc,
      txSigner,
      tip,
      operatorCoupon,
      client: providedClient,
      priceIndex = this.currency.priceIndex,
      currentBitcoinHeight = this.bitcoinLocks.data.oracleBitcoinBlockHeight,
      currentCoverageMicrogons = lock.securitizationCoverageMicrogons ?? 0n,
      maximumFeeCreditMicrogons,
    } = args;
    if (lock.lockId == null || !lock.scriptDetails) {
      throw new Error('This Bitcoin Lock is not available for resecuritization.');
    }
    if (lock.ownerAccount && lock.ownerAccount !== txSigner.address) {
      throw new Error(`Bitcoin Lock #${lock.lockId} belongs to a different account.`);
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
      priceIndex,
      satoshis: securitizedSatoshis,
      microgonsAtTargetPerBtc,
    });
    const quote = BitcoinLockResecuritize.calculateFee({
      lock,
      vault,
      txSigner,
      operatorCoupon,
      maximumFeeCreditMicrogons,
      satoshis: securitizedSatoshis,
      microgonsAtTargetPerBtc,
      currentCoverageMicrogons,
      replacementCoverageMicrogons,
      currentBitcoinHeight,
    });
    const { totalSecurityFee } = quote;
    let securityFee = quote.securityFee;
    let feeCouponRequestId: string | undefined;
    let feeCoupon: BitcoinLockFeeCoupon | undefined;

    if (operatorCoupon && quote.feeCouponRequest) {
      const response = await this.upstreamOperatorClient.initializeBitcoinLock(operatorCoupon.coupon.offerCode, {
        ...quote.feeCouponRequest,
        requestId: quote.feeCouponRequest.requestId ?? BitcoinLocksTable.createUuid(),
      });
      feeCouponRequestId = response.execution.requestId;
      feeCoupon = response.execution.feeCoupon;
      securityFee = bigIntMax(totalSecurityFee - feeCoupon.feeDiscount, 0n);
    }

    const tx = BitcoinLock.createResecuritizeTx({
      client,
      lockId: lock.lockId,
      securitizedSatoshis,
      microgonsAtTargetPerBtc,
      feeCoupon,
    });

    return {
      client,
      txs: [tx],
      txSigner,
      tip,
      unavailableBalance: securityFee,
      includeExistentialDeposit: true,
      feeCouponRequestId,
      replacementCoverageMicrogons,
      totalSecurityFee,
      securityFee,
      metadata: {
        bitcoin: {
          lockId: lock.lockId,
          vaultId: vault.vaultId,
          securitizedSatoshis,
          microgonsAtTargetPerBtc,
          securityFee,
          feeCouponNonce: feeCoupon?.nonce,
          feeCouponRequestId,
        },
      },
    };
  }

  protected getOperationKey(args: BitcoinLockResecuritizeInput): string {
    const { lock, txSigner } = args;
    return `${txSigner.address}:${lock.lockId}`;
  }

  protected matches(
    args: BitcoinLockResecuritizeInput,
    txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>,
  ): boolean {
    const { lock, securitizedSatoshis, microgonsAtTargetPerBtc, txSigner } = args;
    const { bitcoin } = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === txSigner.address &&
      bitcoin.lockId === lock.lockId &&
      bitcoin.securitizedSatoshis === securitizedSatoshis &&
      bitcoin.microgonsAtTargetPerBtc === microgonsAtTargetPerBtc
    );
  }

  public getPendingResecuritizationTxInfo(
    lockId: number,
  ): TransactionInfo<IBitcoinResecuritizationMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.bitcoin.lockId === lockId);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>): Promise<void> {
    await txInfo.txResult.waitForFinalizedBlock;
    await this.transactionTracker.ensureStoredEvents(txInfo);
    await this.finalizeResecuritization(txInfo.tx.metadataJson, txInfo);
  }

  public async finalizeResecuritization(
    metadata: IBitcoinResecuritizationMetadata,
    txInfo: TransactionInfo,
  ): Promise<void> {
    const { lockId, feeCouponRequestId } = metadata.bitcoin;
    const lock = this.bitcoinLocks.getLockById(lockId);
    if (lock) {
      const client = await getMainchainClient(true);
      const blockHash = await txInfo.txResult.waitForFinalizedBlock;
      const current = await getHistoricalBitcoinLockDetails(await client.at(blockHash), lockId);
      if (!current) throw new Error(`Bitcoin Lock #${lockId} was not found after resecuritization.`);
      const payment = BitcoinLock.readLockGuaranteePayment(txInfo.txResult.events, lockId, current.ownerAccount);
      if (!payment) throw new Error(`Bitcoin Lock #${lockId} finalized without its guarantee event.`);
      await this.bitcoinLocks.updateCurrentLock(lock, current, txInfo, payment);
    }
    if (feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Finalized');
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>): Promise<void> {
    await this.failResecuritization(txInfo.tx.metadataJson);
  }

  public async failResecuritization(metadata: IBitcoinResecuritizationMetadata): Promise<void> {
    const { feeCouponRequestId } = metadata.bitcoin;
    if (feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Failed');
    }
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinResecuritizationMetadata, BitcoinLockResecuritizeBuild>,
  ): Promise<void> {
    if (prepared.feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(prepared.feeCouponRequestId, 'Failed');
    }
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinResecuritizationMetadata, BitcoinLockResecuritizeBuild>,
  ): Error {
    const requiredWalletBalanceMicrogons =
      prepared.metadata.bitcoin.securityFee +
      prepared.txFeePlusTip +
      prepared.client.consts.balances.existentialDeposit;
    return new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
  }

  public static calculateFee(
    args: Pick<
      BitcoinLockResecuritizeInput,
      'lock' | 'vault' | 'txSigner' | 'operatorCoupon' | 'maximumFeeCreditMicrogons' | 'microgonsAtTargetPerBtc'
    > & {
      satoshis: bigint;
      currentCoverageMicrogons: bigint;
      replacementCoverageMicrogons: bigint;
      currentBitcoinHeight: number;
      claimedCouponRequestIds?: ReadonlySet<string>;
    },
  ): { totalSecurityFee: bigint; securityFee: bigint; feeCouponRequest?: IBitcoinLockCouponRequest } {
    const {
      lock,
      vault,
      txSigner,
      operatorCoupon,
      maximumFeeCreditMicrogons,
      satoshis,
      microgonsAtTargetPerBtc,
      currentCoverageMicrogons,
      replacementCoverageMicrogons,
      currentBitcoinHeight,
      claimedCouponRequestIds,
    } = args;
    if (lock.lockId == null || !lock.scriptDetails) throw new Error('This Bitcoin Lock is unavailable.');

    const totalSecurityFee = BitcoinLock.calculateResecuritizationFee({
      vault,
      currentCoverageMicrogons,
      replacementCoverageMicrogons,
      currentBitcoinHeight,
      createdAtBitcoinHeight: lock.scriptDetails.createdAtHeight,
      vaultClaimBitcoinHeight: lock.scriptDetails.vaultClaimHeight,
    });
    if (txSigner.address === vault.operatorAccountId) return { totalSecurityFee, securityFee: 0n };

    const pendingUse = operatorCoupon?.uses?.find(use => {
      if (use.status !== 'Prepared') return false;
      if (use.utxoId !== lock.lockId || !use.feeCoupon) return false;
      return !claimedCouponRequestIds?.has(use.requestId);
    });
    const availableCredit =
      (operatorCoupon?.remainingFeeCreditMicrogons ?? 0n) + (pendingUse?.feeCreditMicrogons ?? 0n);
    const creditLimit = bigIntMin(availableCredit, maximumFeeCreditMicrogons ?? availableCredit);
    const feeCreditMicrogons = bigIntMin(totalSecurityFee, creditLimit);
    if (feeCreditMicrogons === 0n) return { totalSecurityFee, securityFee: totalSecurityFee };

    if (!operatorCoupon || operatorCoupon.coupon.vaultId !== vault.vaultId)
      throw new Error('This Bitcoin fee gift is for a different vault.');
    if (operatorCoupon.coupon.accountId && operatorCoupon.coupon.accountId !== txSigner.address)
      throw new Error('This Bitcoin fee gift belongs to a different account.');

    const feeCouponRequest: IBitcoinLockCouponRequest = {
      utxoId: lock.lockId,
      requestedSatoshis: satoshis,
      ownerAccountId: txSigner.address,
      ownerBitcoinPubkey: lock.scriptDetails.ownerPubkey,
      microgonsAtTargetPerBtc,
      feeCreditMicrogons,
    };
    if (pendingUse) {
      feeCouponRequest.requestId = pendingUse.requestId;
      feeCouponRequest.feeCouponNonce = pendingUse.feeCoupon!.nonce;
    }
    return { totalSecurityFee, securityFee: totalSecurityFee - feeCreditMicrogons, feeCouponRequest };
  }
}
