import {
  bigIntMax,
  bigIntMin,
  BitcoinLock,
  SATOSHIS_PER_BITCOIN,
  type ArgonClient,
  type Currency,
  type TxSigningAccount,
  type Vault,
} from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import BitcoinLocks, {
  BitcoinLockWalletFundingError,
  type IBitcoinRequestLockMetadata,
  type IOperatorBitcoinLockCouponRoute,
} from '../BitcoinLocks.ts';
import { BitcoinLocksTable } from '../db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import { RequestStatusError } from '../ServerAuthClient.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLockCreateInput {
  vault: Vault;
  satoshis: bigint;
  txSigner: TxSigningAccount;
  tip?: bigint;
  operatorCoupon?: IOperatorBitcoinLockCouponRoute;
  microgonsAtTargetPerBtc?: bigint;
  client?: ArgonClient;
}

export interface BitcoinLockCreatePreviewInput {
  vault: Vault;
  satoshis: bigint;
  txSigner: TxSigningAccount;
  tip?: bigint;
  microgonsAtTargetPerBtc?: bigint;
  feeDiscountMicrogons?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLockCreatePreview {
  canAfford: boolean;
  requiredWalletBalanceMicrogons: bigint;
  securityFee: bigint;
  txFeePlusTip: bigint;
}

type BitcoinLockCreateBuild = TransactionOperationBuild<IBitcoinRequestLockMetadata> & {
  availableBalance: bigint;
  canAfford: boolean;
  feeCouponRequestId?: string;
  txFeePlusTip: bigint;
};

export class BitcoinLockCreate extends TransactionOperation<
  BitcoinLockCreateInput,
  IBitcoinRequestLockMetadata,
  BitcoinLockCreateBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinRequestLock;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    transactionTracker: TransactionTracker,
    private readonly currency: Currency,
    private readonly upstreamOperatorClient: UpstreamOperatorClient,
  ) {
    super(transactionTracker);
  }

  public async preview(input: BitcoinLockCreatePreviewInput): Promise<IBitcoinLockCreatePreview> {
    const { vault, satoshis, txSigner, tip, microgonsAtTargetPerBtc, feeDiscountMicrogons = 0n } = input;
    const client = input.client ?? (await getMainchainClient(false));
    const { ownerBitcoinPubkey } = await this.bitcoinLocks.getInitializePreviewPubkey(vault);
    const estimate = await BitcoinLock.createInitializeTx({
      client,
      vault,
      priceIndex: this.currency.priceIndex,
      ownerBitcoinPubkey,
      txSigner,
      tip,
      microgonsAtTargetPerBtc,
      satoshis,
    });
    const securityFee = bigIntMax(estimate.securityFee - feeDiscountMicrogons, 0n);
    const requiredWalletBalanceMicrogons =
      securityFee + estimate.txFeePlusTip + client.consts.balances.existentialDeposit.toBigInt();

    return {
      canAfford: estimate.availableBalance >= requiredWalletBalanceMicrogons,
      requiredWalletBalanceMicrogons,
      securityFee,
      txFeePlusTip: estimate.txFeePlusTip,
    };
  }

  public override async prepare(
    input: BitcoinLockCreateInput,
  ): Promise<PreparedTransactionOperation<IBitcoinRequestLockMetadata, BitcoinLockCreateBuild>> {
    const build = await this.build(input);
    return {
      ...build,
      tx: build.txs[0],
      availableBalance: build.availableBalance,
      canAfford: build.canAfford,
      txFeePlusTip: build.txFeePlusTip,
    };
  }

  protected async build(input: BitcoinLockCreateInput): Promise<BitcoinLockCreateBuild> {
    const { vault, satoshis, txSigner, tip, operatorCoupon } = input;
    const client = input.client ?? (await getMainchainClient(false));
    const minimumSatoshis = await client.query.bitcoinLocks.minimumSatoshis();
    if (satoshis !== 0n && satoshis < minimumSatoshis) {
      throw new Error(
        `Unable to create a bitcoin lock with the given sats: ${satoshis}. Minimum is ${minimumSatoshis}`,
      );
    }
    if (!this.currency.priceIndex.btcUsdPrice) {
      throw new Error('Network bitcoin pricing is currently unavailable. Please try again later.');
    }
    if (operatorCoupon?.vaultId !== undefined && operatorCoupon.vaultId !== vault.vaultId) {
      throw new Error('This bitcoin lock coupon is for a different vault.');
    }
    if (operatorCoupon?.accountId && operatorCoupon.accountId !== txSigner.address) {
      throw new Error(
        `This invite is claimed by ${operatorCoupon.accountId}. Import or switch to that account before continuing.`,
      );
    }

    const microgonsAtTargetPerBtc =
      input.microgonsAtTargetPerBtc ?? this.currency.priceIndex.getSatoshiPriceInTargetMicrogons(SATOSHIS_PER_BITCOIN);
    const liquidityPromised = this.bitcoinLocks.argonLiquidityForSatoshis(satoshis, microgonsAtTargetPerBtc);
    let feeCouponRequestId: string | undefined;
    let feeCoupon;

    if (operatorCoupon) {
      const pendingInitialization = operatorCoupon.pendingInitialization;
      const feeCouponNonce = pendingInitialization?.feeCoupon?.nonce;
      if (pendingInitialization && feeCouponNonce == null) {
        throw new Error('This Bitcoin lock initialization is missing its signed fee coupon.');
      }
      if (operatorCoupon.remainingFeeCreditMicrogons == null && !pendingInitialization) {
        throw new Error(
          'This Bitcoin fee gift is waiting for your upstream operator to update it for the current network.',
        );
      }

      const availableFeeCreditMicrogons =
        (operatorCoupon.remainingFeeCreditMicrogons ?? 0n) + (pendingInitialization?.feeCreditMicrogons ?? 0n);
      const variableFee = bigIntMax(vault.calculateBitcoinFee(liquidityPromised) - vault.terms.bitcoinBaseFee, 0n);
      const feeCreditMicrogons = bigIntMin(variableFee, availableFeeCreditMicrogons);
      if (feeCreditMicrogons <= 0n) throw new Error('This Bitcoin fee gift has no remaining credit.');

      const { ownerBitcoinPubkey: previewPubkey } = await this.bitcoinLocks.getInitializePreviewPubkey(vault);
      const feeEstimate = await BitcoinLock.createInitializeTx({
        client,
        vault,
        priceIndex: this.currency.priceIndex,
        ownerBitcoinPubkey: previewPubkey,
        txSigner,
        microgonsAtTargetPerBtc,
        satoshis,
        tip,
      });
      const existentialDeposit = client.consts.balances.existentialDeposit.toBigInt();
      const memberSecurityFee = bigIntMax(feeEstimate.securityFee - feeCreditMicrogons, 0n);
      const requiredWalletBalanceMicrogons = memberSecurityFee + feeEstimate.txFeePlusTip + existentialDeposit;
      if (feeEstimate.availableBalance < requiredWalletBalanceMicrogons) {
        throw new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
      }

      const { ownerBitcoinPubkey, hdPath } = await this.bitcoinLocks.allocateUtxoPubkey(vault);
      const response = await this.upstreamOperatorClient.initializeBitcoinLock(operatorCoupon.offerCode, {
        requestId: pendingInitialization?.requestId ?? BitcoinLocksTable.createUuid(),
        feeCouponNonce,
        feeCreditMicrogons,
        ownerAccountId: txSigner.address,
        ownerBitcoinPubkey: u8aToHex(ownerBitcoinPubkey),
        requestedSatoshis: satoshis,
        microgonsAtTargetPerBtc,
      });
      if (response.execution?.type !== 'FeeCoupon') {
        throw new RequestStatusError(
          'Your upstream operator must update before it can provide a Bitcoin fee gift for the current network.',
          426,
          'UPSTREAM_UPGRADE_REQUIRED',
        );
      }
      feeCouponRequestId = response.execution.requestId;
      feeCoupon = response.execution.feeCoupon;

      let initialization;
      try {
        initialization = await BitcoinLock.createInitializeTx({
          client,
          vault,
          priceIndex: this.currency.priceIndex,
          ownerBitcoinPubkey,
          txSigner,
          microgonsAtTargetPerBtc,
          satoshis,
          tip,
          feeCoupon,
        });
      } catch (error) {
        await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Failed');
        throw error;
      }

      return this.createBuild({
        client,
        vault,
        satoshis,
        txSigner,
        tip,
        microgonsAtTargetPerBtc,
        liquidityPromised,
        hdPath,
        initialization,
        feeCouponRequestId,
        feeCouponNonce: feeCoupon.nonce,
      });
    }

    const { ownerBitcoinPubkey, hdPath } = await this.bitcoinLocks.allocateUtxoPubkey(vault);
    const initialization = await BitcoinLock.createInitializeTx({
      client,
      vault,
      priceIndex: this.currency.priceIndex,
      ownerBitcoinPubkey,
      txSigner,
      microgonsAtTargetPerBtc,
      satoshis,
      tip,
    });
    return this.createBuild({
      client,
      vault,
      satoshis,
      txSigner,
      tip,
      microgonsAtTargetPerBtc,
      liquidityPromised,
      hdPath,
      initialization,
    });
  }

  protected getOperationKey(input: BitcoinLockCreateInput): string {
    return `${input.txSigner.address}:${input.vault.vaultId}:${input.satoshis}`;
  }

  protected matches(input: BitcoinLockCreateInput, txInfo: TransactionInfo<IBitcoinRequestLockMetadata>): boolean {
    const bitcoin = txInfo.tx.metadataJson.bitcoin;
    const pendingNonce = input.operatorCoupon?.pendingInitialization?.feeCoupon?.nonce;
    return (
      txInfo.tx.accountAddress === input.txSigner.address &&
      bitcoin.vaultId === input.vault.vaultId &&
      bitcoin.satoshis === input.satoshis &&
      (input.microgonsAtTargetPerBtc === undefined || bitcoin.lockedTargetPrice === input.microgonsAtTargetPerBtc) &&
      (pendingNonce === undefined || bitcoin.feeCouponNonce === pendingNonce)
    );
  }

  public getPendingLockTxInfo(uuid: string): TransactionInfo<IBitcoinRequestLockMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.bitcoin.uuid === uuid);
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinRequestLockMetadata>): Promise<void> {
    await this.bitcoinLocks.publishPendingLock(txInfo.tx.metadataJson);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinRequestLockMetadata>): Promise<void> {
    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    const archiveClient = await getMainchainClient(true);
    await this.transactionTracker.ensureStoredEvents(txInfo);
    const { lock } = await BitcoinLock.getBitcoinLockFromTxResult(await archiveClient.at(blockHash), txInfo.txResult);
    await this.bitcoinLocks.finalizeCreatedLock(txInfo.tx.metadataJson.bitcoin.uuid, lock);
    const feeCouponRequestId = txInfo.tx.metadataJson.bitcoin.feeCouponRequestId;
    if (feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Finalized');
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinRequestLockMetadata>, error: Error): Promise<void> {
    await this.bitcoinLocks.failPendingLock(txInfo.tx.metadataJson.bitcoin.uuid, error);
    const feeCouponRequestId = txInfo.tx.metadataJson.bitcoin.feeCouponRequestId;
    if (feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Failed');
    }
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinRequestLockMetadata, BitcoinLockCreateBuild>,
  ): Promise<void> {
    if (prepared.feeCouponRequestId) {
      await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(prepared.feeCouponRequestId, 'Failed');
    }
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinRequestLockMetadata, BitcoinLockCreateBuild>,
  ): Error {
    const requiredWalletBalanceMicrogons =
      prepared.metadata.bitcoin.securityFee +
      prepared.txFeePlusTip +
      prepared.client.consts.balances.existentialDeposit.toBigInt();
    return new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
  }

  private createBuild(args: {
    client: ArgonClient;
    vault: Vault;
    satoshis: bigint;
    txSigner: TxSigningAccount;
    tip?: bigint;
    microgonsAtTargetPerBtc: bigint;
    liquidityPromised: bigint;
    hdPath: string;
    initialization: Awaited<ReturnType<typeof BitcoinLock.createInitializeTx>>;
    feeCouponRequestId?: string;
    feeCouponNonce?: bigint;
  }): BitcoinLockCreateBuild {
    const {
      client,
      vault,
      satoshis,
      txSigner,
      tip,
      microgonsAtTargetPerBtc,
      liquidityPromised,
      hdPath,
      initialization,
      feeCouponRequestId,
      feeCouponNonce,
    } = args;
    return {
      client,
      txs: [initialization.tx],
      txSigner,
      tip,
      includeExistentialDeposit: true,
      availableBalance: initialization.availableBalance,
      canAfford: initialization.canAfford,
      txFeePlusTip: initialization.txFeePlusTip,
      feeCouponRequestId,
      metadata: {
        bitcoin: {
          uuid: BitcoinLocksTable.createUuid(),
          vaultId: vault.vaultId,
          satoshis,
          hdPath,
          lockedTargetPrice: microgonsAtTargetPerBtc,
          liquidityPromised,
          securityFee: initialization.securityFee,
          feeCouponNonce,
          feeCouponRequestId,
        },
      },
    };
  }
}
