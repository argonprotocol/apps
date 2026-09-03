import {
  bigIntMax,
  bigIntMin,
  BitcoinLock,
  type BitcoinLockFeeCoupon,
  type Currency,
  type IBitcoinLockCouponStatus,
  type ArgonClient,
  type TxSigningAccount,
  type Vault,
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
  maximumFeeCreditMicrogons?: bigint;
}

export interface IBitcoinResecuritizationMetadata {
  bitcoin: {
    utxoId: number;
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
      maximumFeeCreditMicrogons,
    } = args;
    if (lock.utxoId == null || !lock.scriptDetails) {
      throw new Error('This Bitcoin Lock is not available for resecuritization.');
    }
    if (lock.ownerAccount && lock.ownerAccount !== txSigner.address) {
      throw new Error(`Bitcoin Lock #${lock.utxoId} belongs to a different account.`);
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
      priceIndex,
      satoshis: securitizedSatoshis,
      microgonsAtTargetPerBtc,
    });
    const totalSecurityFee = BitcoinLock.calculateResecuritizationFee({
      vault,
      currentCoverageMicrogons: lock.securitizationCoverageMicrogons ?? 0n,
      replacementCoverageMicrogons,
      createdAtBitcoinHeight: lock.scriptDetails.createdAtHeight,
      vaultClaimBitcoinHeight: lock.scriptDetails.vaultClaimHeight,
      currentBitcoinHeight,
    });
    const pendingUse = operatorCoupon?.uses?.find(
      use => use.status === 'Prepared' && use.utxoId === lock.utxoId && use.feeCoupon,
    );
    const availableFeeCreditMicrogons =
      (operatorCoupon?.remainingFeeCreditMicrogons ?? 0n) + (pendingUse?.feeCreditMicrogons ?? 0n);
    const maximumFeeCredit = bigIntMin(
      availableFeeCreditMicrogons,
      maximumFeeCreditMicrogons ?? availableFeeCreditMicrogons,
    );
    const requestedFeeCreditMicrogons =
      txSigner.address === vault.operatorAccountId ? 0n : bigIntMin(totalSecurityFee, maximumFeeCredit);
    let feeCouponRequestId: string | undefined;
    let feeCoupon: BitcoinLockFeeCoupon | undefined;

    if (requestedFeeCreditMicrogons > 0n) {
      if (!operatorCoupon || operatorCoupon.coupon.vaultId !== vault.vaultId) {
        throw new Error('This Bitcoin fee gift is for a different vault.');
      }
      if (operatorCoupon.coupon.accountId && operatorCoupon.coupon.accountId !== txSigner.address) {
        throw new Error(
          `This invite is claimed by ${operatorCoupon.coupon.accountId}. Import or switch to that account before continuing.`,
        );
      }

      const response = await this.upstreamOperatorClient.initializeBitcoinLock(operatorCoupon.coupon.offerCode, {
        requestId: pendingUse?.requestId ?? BitcoinLocksTable.createUuid(),
        feeCouponNonce: pendingUse?.feeCoupon?.nonce,
        utxoId: lock.utxoId,
        requestedSatoshis: securitizedSatoshis,
        ownerAccountId: txSigner.address,
        ownerBitcoinPubkey: lock.scriptDetails.ownerPubkey,
        microgonsAtTargetPerBtc,
        feeCreditMicrogons: requestedFeeCreditMicrogons,
      });
      feeCouponRequestId = response.execution.requestId;
      feeCoupon = response.execution.feeCoupon;
    }

    const securityFee =
      txSigner.address === vault.operatorAccountId
        ? 0n
        : bigIntMax(totalSecurityFee - (feeCoupon?.feeDiscount ?? 0n), 0n);
    const tx = BitcoinLock.createResecuritizeTx({
      client,
      utxoId: lock.utxoId,
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
          utxoId: lock.utxoId,
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
    return `${txSigner.address}:${lock.utxoId}`;
  }

  protected matches(
    args: BitcoinLockResecuritizeInput,
    txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>,
  ): boolean {
    const { lock, securitizedSatoshis, microgonsAtTargetPerBtc, txSigner } = args;
    const { bitcoin } = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === txSigner.address &&
      bitcoin.utxoId === lock.utxoId &&
      bitcoin.securitizedSatoshis === securitizedSatoshis &&
      bitcoin.microgonsAtTargetPerBtc === microgonsAtTargetPerBtc
    );
  }

  public getPendingResecuritizationTxInfo(
    utxoId: number,
  ): TransactionInfo<IBitcoinResecuritizationMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.bitcoin.utxoId === utxoId);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinResecuritizationMetadata>): Promise<void> {
    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    await this.finalizeResecuritization(txInfo.tx.metadataJson, blockHash);
  }

  public async finalizeResecuritization(
    metadata: IBitcoinResecuritizationMetadata,
    blockHash: Uint8Array,
  ): Promise<void> {
    const { utxoId, feeCouponRequestId } = metadata.bitcoin;
    await this.bitcoinLocks.load();
    const lock = this.bitcoinLocks.getLockByUtxoId(utxoId);
    if (lock) {
      const client = await getMainchainClient(true);
      const current = await BitcoinLock.get(await client.at(blockHash), utxoId);
      if (!current) throw new Error(`Bitcoin Lock #${utxoId} was not found after resecuritization.`);
      await (await this.bitcoinLocks.getTable()).setCurrentLockFunded(lock, current);
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
      prepared.client.consts.balances.existentialDeposit.toBigInt();
    return new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
  }
}
