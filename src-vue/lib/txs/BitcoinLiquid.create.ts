import {
  bigIntMax,
  bigIntMin,
  BitcoinFission,
  BitcoinLock,
  Currency,
  createDeferred,
  NetworkConfig,
  SATS_PER_BTC,
  SingleFileQueue,
  type IBitcoinLockCouponStatus,
  type IBitcoinFissionCreationQuote,
  type ArgonClient,
  type BlockWatch,
  type TxSigningAccount,
  Vault,
  type Vaults,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import BitcoinLocks, { BitcoinLockWalletFundingError } from '../BitcoinLocks.ts';
import type { BitcoinFissions } from '../BitcoinFissions.ts';
import { BitcoinLocksTable, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { BitcoinLockResecuritize, type IBitcoinResecuritizationMetadata } from './BitcoinLock.resecuritize.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLiquidCreateAllocation {
  lock: IBitcoinLockRecord;
  satoshis: bigint;
  operatorCoupon?: IBitcoinLockCouponStatus;
}

export interface BitcoinLiquidCreateInput {
  allocations: BitcoinLiquidCreateAllocation[];
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLiquidCreateMetadata {
  liquidId: number;
  snapshotBlockHash: string;
  fissions: IBitcoinLiquidCreateFission[];
  resecuritizations: IBitcoinResecuritizationMetadata[];
}

export interface IBitcoinLiquidCreateFission {
  fissionId: number;
  lockId: number;
  satoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised: bigint;
  securityFee?: bigint;
  feeCouponRequestId?: string;
}

type QuotedAllocation = {
  allocation: BitcoinLiquidCreateAllocation;
  vault: Vault;
  quote: IBitcoinFissionCreationQuote;
};

type CurrentCreateState = {
  client: ArgonClient;
  snapshotBlockHash: string;
  priceIndex: PriceIndex;
  currentBitcoinHeight: number;
  nextFissionId: number;
  microgonsAtTargetPerBtc: bigint;
  microgonsAtTargetPerBtcTick: number;
  allocations: QuotedAllocation[];
};

type BitcoinLiquidCreateBuild = TransactionOperationBuild<IBitcoinLiquidCreateMetadata>;

export interface IBitcoinLiquidCreatePreview {
  microgonsAtTargetPerBtc: bigint;
  microgonsAtTargetPerBtcTick: number;
  liquidityMicrogons: bigint;
  totalSecurityFeeMicrogons: bigint;
  securityFeeMicrogons: bigint;
  couponCreditMicrogons: bigint;
  maximumSatoshisByLockId: Readonly<Record<number, bigint>>;
}

export class BitcoinLiquidCreateStateChangedError extends Error {
  constructor(
    message: string,
    public readonly maximumSatoshisByLockId: Readonly<Record<number, bigint>> = {},
  ) {
    super(message);
  }
}

export class BitcoinLiquidCreate extends TransactionOperation<
  BitcoinLiquidCreateInput,
  IBitcoinLiquidCreateMetadata,
  BitcoinLiquidCreateBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinLiquidCreate;
  private readonly submissionQueue = new SingleFileQueue();

  constructor(
    private readonly fissions: BitcoinFissions,
    transactionTracker: TransactionTracker,
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly vaults: Vaults,
    private readonly bitcoinLockResecuritize: BitcoinLockResecuritize,
    private readonly upstreamOperatorClient: UpstreamOperatorClient,
    private readonly blockWatch: BlockWatch,
  ) {
    super(transactionTracker);
  }

  public override async submit(args: BitcoinLiquidCreateInput): Promise<TransactionInfo<IBitcoinLiquidCreateMetadata>> {
    const submission = createDeferred<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
    this.submissionQueue.add(async () => {
      try {
        const txInfo = await super.submit(args);
        submission.resolve(txInfo);
        await txInfo.txResult.waitForFinalizedBlock;
      } catch (error) {
        submission.reject(error as Error);
      }
    });
    return await submission.promise;
  }

  public async preview(args: BitcoinLiquidCreateInput): Promise<IBitcoinLiquidCreatePreview> {
    const { txSigner } = args;
    const { microgonsAtTargetPerBtc, microgonsAtTargetPerBtcTick, allocations } = await this.readCurrentState(args);
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(allocations);
    let liquidityMicrogons = 0n;
    let totalSecurityFeeMicrogons = 0n;
    let securityFeeMicrogons = 0n;
    let couponCreditMicrogons = 0n;

    for (const allocation of allocations) {
      const { allocation: input, vault, quote } = allocation;
      const { operatorCoupon } = input;
      const totalSecurityFee = (quote.lockGuarantee ?? quote.fissionGuarantee)?.totalSecurityFee ?? 0n;
      const availableFeeCredit = operatorCoupon
        ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
        : 0n;
      const couponCredit =
        txSigner.address === vault.operatorAccountId ? 0n : bigIntMin(totalSecurityFee, availableFeeCredit);
      if (operatorCoupon) {
        remainingFeeCreditByCouponId.set(operatorCoupon.coupon.id, availableFeeCredit - couponCredit);
      }

      liquidityMicrogons += quote.fission.liquidityPromised;
      totalSecurityFeeMicrogons += totalSecurityFee;
      if (txSigner.address !== vault.operatorAccountId) {
        securityFeeMicrogons += totalSecurityFee - couponCredit;
        couponCreditMicrogons += couponCredit;
      }
    }

    return {
      microgonsAtTargetPerBtc,
      microgonsAtTargetPerBtcTick,
      liquidityMicrogons,
      totalSecurityFeeMicrogons,
      securityFeeMicrogons,
      couponCreditMicrogons,
      maximumSatoshisByLockId: Object.fromEntries(
        allocations.map(({ allocation, quote }) => [allocation.lock.lockId!, quote.maximumSatoshis]),
      ),
    };
  }

  protected async build(args: BitcoinLiquidCreateInput): Promise<BitcoinLiquidCreateBuild> {
    const { txSigner, tip } = args;
    const { client, snapshotBlockHash, priceIndex, currentBitcoinHeight, nextFissionId, allocations } =
      await this.readCurrentState(args);
    const metadata: IBitcoinLiquidCreateMetadata = {
      liquidId: nextFissionId,
      snapshotBlockHash,
      fissions: [],
      resecuritizations: [],
    };
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(allocations);
    const lockGuaranteeTxs = [];
    const fissionTxs = [];
    let securityFee = 0n;

    try {
      for (const [index, { allocation, vault, quote }] of allocations.entries()) {
        const { lock, operatorCoupon } = allocation;
        const fission: IBitcoinLiquidCreateFission = {
          fissionId: nextFissionId + index,
          lockId: lock.lockId!,
          ...quote.fission,
        };
        metadata.fissions.push(fission);

        const availableFeeCredit = operatorCoupon
          ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
          : 0n;
        let paidSecurityFee = 0n;
        let feeCoupon;

        if (quote.lockGuarantee) {
          const guarantee = quote.lockGuarantee;
          const prepared = await this.bitcoinLockResecuritize.prepare({
            lock,
            vault,
            securitizedSatoshis: guarantee.satoshis,
            microgonsAtTargetPerBtc: guarantee.microgonsAtTargetPerBtc,
            currentCoverageMicrogons: guarantee.currentCoverageMicrogons,
            txSigner,
            operatorCoupon,
            client,
            priceIndex,
            currentBitcoinHeight,
            maximumFeeCreditMicrogons: availableFeeCredit,
          });
          metadata.resecuritizations.push(prepared.metadata);
          lockGuaranteeTxs.push(prepared.tx);
          paidSecurityFee = prepared.securityFee;
        }

        if (quote.fissionGuarantee) {
          const feeQuote = BitcoinLockResecuritize.calculateFee({
            ...quote.fissionGuarantee,
            lock,
            vault,
            txSigner,
            operatorCoupon,
            currentBitcoinHeight,
            maximumFeeCreditMicrogons: availableFeeCredit,
          });
          fission.securityFee = feeQuote.securityFee;
          if (operatorCoupon && feeQuote.feeCouponRequest) {
            const response = await this.upstreamOperatorClient.initializeBitcoinLock(operatorCoupon.coupon.offerCode, {
              ...feeQuote.feeCouponRequest,
              requestId: feeQuote.feeCouponRequest.requestId ?? BitcoinLocksTable.createUuid(),
            });
            fission.feeCouponRequestId = response.execution.requestId;
            feeCoupon = response.execution.feeCoupon;
            fission.securityFee = bigIntMax(feeQuote.totalSecurityFee - feeCoupon.feeDiscount, 0n);
          }
          paidSecurityFee = fission.securityFee;
        }

        securityFee += paidSecurityFee;
        if (operatorCoupon && txSigner.address !== vault.operatorAccountId) {
          const totalSecurityFee = (quote.lockGuarantee ?? quote.fissionGuarantee)?.totalSecurityFee ?? 0n;
          const couponCredit = totalSecurityFee - paidSecurityFee;
          remainingFeeCreditByCouponId.set(operatorCoupon.coupon.id, bigIntMax(availableFeeCredit - couponCredit, 0n));
        }
        fissionTxs.push(BitcoinFission.createTx({ client, liquidId: nextFissionId, ...fission, feeCoupon }));
      }
    } catch (error) {
      await this.failGuaranteePurchases(metadata);
      throw error;
    }

    return {
      client,
      txs: [...lockGuaranteeTxs, ...fissionTxs],
      txSigner,
      tip,
      unavailableBalance: securityFee,
      includeExistentialDeposit: true,
      metadata,
    };
  }

  protected getOperationKey(args: BitcoinLiquidCreateInput): string {
    const { allocations, txSigner } = args;
    return `${txSigner.address}:${allocations.map(({ lock, satoshis }) => `${lock.lockId}:${satoshis}`).join(',')}`;
  }

  protected matches(args: BitcoinLiquidCreateInput, txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): boolean {
    const { allocations, txSigner } = args;
    const { fissions } = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === txSigner.address &&
      fissions.length === allocations.length &&
      fissions.every((fission, index) => {
        const allocation = allocations[index];
        return fission.lockId === allocation.lock.lockId && fission.satoshis === allocation.satoshis;
      })
    );
  }

  public getPendingLiquidTxInfo(liquidId: number): TransactionInfo<IBitcoinLiquidCreateMetadata> | undefined {
    return this.getPendingLiquidTxInfos().find(txInfo => txInfo.tx.metadataJson.liquidId === liquidId);
  }

  public getPendingLiquidTxInfos(): TransactionInfo<IBitcoinLiquidCreateMetadata>[] {
    const pendingLiquidIds = new Set(this.fissions.getPendingLiquids().map(liquid => liquid.liquidId));
    const foundLiquidIds = new Set<number>();

    return this.getActiveTransactions(txInfo => {
      return (
        txInfo.tx.accountAddress === this.fissions.ownerAccount && pendingLiquidIds.has(txInfo.tx.metadataJson.liquidId)
      );
    })
      .toSorted((left, right) => right.tx.id - left.tx.id)
      .filter(txInfo => {
        const { liquidId } = txInfo.tx.metadataJson;
        if (foundLiquidIds.has(liquidId)) return false;

        foundLiquidIds.add(liquidId);
        return true;
      });
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    const { liquidId, fissions } = txInfo.tx.metadataJson;
    const now = new Date();
    this.fissions.publishPendingFissions(
      fissions.map(
        fission =>
          new BitcoinFission({
            ...fission,
            ownerAccount: this.fissions.ownerAccount,
            liquidId,
            ratchetNumber: 0,
            origin: 'created',
            ratchets: [],
            createdAt: now,
            updatedAt: now,
          }),
      ),
    );
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    await txInfo.txResult.waitForFinalizedBlock;
    await this.transactionTracker.ensureStoredEvents(txInfo);
    for (const metadata of txInfo.tx.metadataJson.resecuritizations) {
      await this.bitcoinLockResecuritize.finalizeResecuritization(metadata, txInfo);
    }
    await this.fissions.recordFinalizedTransaction(txInfo);
    for (const { feeCouponRequestId } of txInfo.tx.metadataJson.fissions) {
      if (feeCouponRequestId)
        await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Finalized');
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    await this.failGuaranteePurchases(txInfo.tx.metadataJson);
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLiquidCreateMetadata, BitcoinLiquidCreateBuild>,
  ): Promise<void> {
    await this.failGuaranteePurchases(prepared.metadata);
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLiquidCreateMetadata, BitcoinLiquidCreateBuild>,
  ): Error {
    const requiredWalletBalanceMicrogons =
      (prepared.unavailableBalance ?? 0n) + prepared.txFeePlusTip + prepared.client.consts.balances.existentialDeposit;
    return new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
  }

  private async readCurrentState(args: BitcoinLiquidCreateInput): Promise<CurrentCreateState> {
    const { allocations: requestedAllocations, txSigner, client: providedClient } = args;
    let allocations = requestedAllocations;
    if (!allocations.length) throw new Error('Select Bitcoin to create this Liquid.');
    if (allocations.some(({ satoshis }) => satoshis <= 0n)) {
      throw new Error('A Liquid cannot include an empty Bitcoin allocation.');
    }
    if (new Set(allocations.map(({ lock }) => lock.lockId)).size !== allocations.length) {
      throw new Error('Each Bitcoin Lock can only be included once in a Liquid.');
    }
    if (txSigner.address !== this.fissions.ownerAccount) {
      throw new Error('This Liquid belongs to a different account.');
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const { block, api: snapshotClient } = await this.blockWatch.getLatestFinalizedSnapshot();
    const priceIndex = await Currency.fetchPriceIndex(snapshotClient);
    if (allocations.some(({ operatorCoupon }) => operatorCoupon)) {
      const currentCoupons = await this.upstreamOperatorClient.getBitcoinLockCoupons();
      allocations = allocations.map(allocation => {
        const { operatorCoupon } = allocation;
        if (!operatorCoupon) return allocation;

        const currentCoupon = currentCoupons.find(({ coupon }) => coupon.id === operatorCoupon.coupon.id);
        if (!currentCoupon) {
          throw new BitcoinLiquidCreateStateChangedError('Your Bitcoin fee gift is no longer available.');
        }
        if (
          currentCoupon.status !== operatorCoupon.status ||
          currentCoupon.remainingFeeCreditMicrogons !== operatorCoupon.remainingFeeCreditMicrogons
        ) {
          throw new BitcoinLiquidCreateStateChangedError('Your Bitcoin fee gift changed. Review the updated fees.');
        }
        return { ...allocation, operatorCoupon: currentCoupon };
      });
    }
    if (allocations.some(({ lock }) => lock.lockId == null)) {
      throw new BitcoinLiquidCreateStateChangedError('Some of this Bitcoin is no longer available on Argon.');
    }
    const lockIds = allocations.map(({ lock }) => lock.lockId!);
    const [runtimeLocks, releaseRequests, bitcoinTip, nextFissionId, rateHistory, currentTick] = await Promise.all([
      snapshotClient.query.bitcoinLocks.locksById.multi(lockIds),
      Promise.all(lockIds.map(lockId => BitcoinLock.getReleaseRequest(snapshotClient, lockId))),
      snapshotClient.query.bitcoinUtxos.confirmedBitcoinBlockTip(),
      BitcoinFission.nextId(snapshotClient, txSigner.address),
      snapshotClient.query.bitcoinLocks.microgonPerBtcHistory(),
      snapshotClient.query.ticks.currentTick(),
    ]);
    if (!rateHistory?.length) {
      throw new BitcoinLiquidCreateStateChangedError('Network Bitcoin pricing is currently unavailable.');
    }

    // A fresh index can confirm an unchanged rate without updating its history tick.
    const oldestRateTick = BigInt(currentTick) - 20n;
    let currentRate: bigint | undefined;
    if (priceIndex.lastUpdatedTick !== undefined && priceIndex.lastUpdatedTick >= oldestRateTick) {
      currentRate = priceIndex.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC);
    }

    // Leave ten ticks for submitting older rates that differ from the current price.
    const eligibleRates = rateHistory.filter(([tick, rate]) => rate === currentRate || tick >= oldestRateTick);
    if (!eligibleRates.length) {
      throw new BitcoinLiquidCreateStateChangedError('Wait for a fresh Bitcoin price and retry.');
    }
    const [microgonsAtTargetPerBtcTick, microgonsAtTargetPerBtc] = eligibleRates.at(-1)!;
    const currentLocks = runtimeLocks ?? [];
    let currentFissions: BitcoinFission[] = [];
    if (currentLocks.some(lock => lock && lock.fissionedSatoshis > 0n)) {
      currentFissions = await BitcoinFission.getAllByOwner(snapshotClient, txSigner.address);
    }

    const vaultIds = [...new Set(currentLocks.flatMap(lock => (lock ? [lock.vaultId] : [])))];
    const vaults = await Promise.all(
      vaultIds.map(vaultId => Vault.get(snapshotClient, vaultId, NetworkConfig.tickMillis)),
    );
    const vaultsById = new Map(vaults.map(vault => [vault.vaultId, vault]));
    const currentBitcoinHeight = bitcoinTip?.blockHeight ?? 0;
    const remainingCapacityByVaultId = new Map<number, Vault>();
    const maximumSatoshisByLockId: Record<number, bigint> = Object.fromEntries(
      currentLocks.flatMap((lock, index) => {
        if (!lock) return [];
        return [[lockIds[index], bigIntMax(lock.fundedSatoshis - lock.fissionedSatoshis, 0n)]];
      }),
    );
    const currentAllocations: QuotedAllocation[] = [];
    let capacityChanged = false;

    for (const [index, allocation] of allocations.entries()) {
      const { satoshis } = allocation;
      const lockId = lockIds[index];
      const runtimeLock = currentLocks[index];
      if (!runtimeLock) {
        throw new BitcoinLiquidCreateStateChangedError('Some of this Bitcoin is no longer available on Argon.');
      }
      if (runtimeLock.ownerAccount !== txSigner.address) {
        throw new Error(`Bitcoin Lock #${lockId} belongs to a different account.`);
      }
      if (releaseRequests[index]) {
        throw new BitcoinLiquidCreateStateChangedError(`Bitcoin Lock #${lockId} is already being returned.`);
      }
      const vault = vaultsById.get(runtimeLock.vaultId)!;
      this.vaults.vaultsById[vault.vaultId] = vault;

      const quote = BitcoinLock.quoteFissionCreation({
        lockId,
        lock: runtimeLock,
        satoshis,
        vault: remainingCapacityByVaultId.get(vault.vaultId) ?? vault,
        priceIndex,
        microgonsAtTargetPerBtc,
        eligibleRates,
        lockFissions: currentFissions.filter(fission => fission.lockId === lockId),
        currentBitcoinHeight,
      });
      if ('error' in quote) {
        const vaultName = this.vaults.operatorNamesByVaultId[vault.vaultId] ?? `Vault ${vault.vaultId}`;
        const message = `${vaultName}: ${quote.error}`;
        if (quote.maximumSatoshis === undefined) throw new BitcoinLiquidCreateStateChangedError(message);
        maximumSatoshisByLockId[lockId] = quote.maximumSatoshis;
        throw new BitcoinLiquidCreateStateChangedError(message, maximumSatoshisByLockId);
      }

      maximumSatoshisByLockId[lockId] = quote.maximumSatoshis;
      if (quote.fission.satoshis < satoshis) capacityChanged = true;
      remainingCapacityByVaultId.set(vault.vaultId, quote.projectedVault);
      currentAllocations.push({ allocation, vault, quote });
    }

    if (capacityChanged) {
      throw new BitcoinLiquidCreateStateChangedError(
        'The selected vaults can no longer guarantee the full selected Bitcoin amount.',
        maximumSatoshisByLockId,
      );
    }

    return {
      client,
      snapshotBlockHash: block.blockHash,
      priceIndex,
      currentBitcoinHeight,
      nextFissionId,
      microgonsAtTargetPerBtc,
      microgonsAtTargetPerBtcTick: Number(microgonsAtTargetPerBtcTick),
      allocations: currentAllocations,
    };
  }

  private getAvailableFeeCreditByCouponId(allocations: QuotedAllocation[]): Map<number, bigint> {
    const plannedLockIds = new Set(allocations.map(({ allocation }) => allocation.lock.lockId));
    const availableByCouponId = new Map<number, bigint>();
    for (const { allocation } of allocations) {
      const { operatorCoupon } = allocation;
      if (!operatorCoupon || availableByCouponId.has(operatorCoupon.coupon.id)) continue;
      const resumableCredit =
        operatorCoupon.uses?.reduce((total, use) => {
          return use.status === 'Prepared' && use.feeCoupon && use.utxoId != null && plannedLockIds.has(use.utxoId)
            ? total + use.feeCreditMicrogons
            : total;
        }, 0n) ?? 0n;
      availableByCouponId.set(
        operatorCoupon.coupon.id,
        (operatorCoupon.remainingFeeCreditMicrogons ?? 0n) + resumableCredit,
      );
    }
    return availableByCouponId;
  }

  private async failGuaranteePurchases(metadata: IBitcoinLiquidCreateMetadata): Promise<void> {
    await Promise.all(
      metadata.resecuritizations.map(purchase => this.bitcoinLockResecuritize.failResecuritization(purchase)),
    );
    for (const { feeCouponRequestId } of metadata.fissions) {
      if (feeCouponRequestId)
        await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Failed');
    }
  }
}
