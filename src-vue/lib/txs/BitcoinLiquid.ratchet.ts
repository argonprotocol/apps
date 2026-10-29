import {
  bigIntMax,
  BitcoinFission,
  BitcoinLock,
  Currency,
  type IBitcoinLockCouponStatus,
  NetworkConfig,
  type ArgonClient,
  type BlockWatch,
  type TxSigningAccount,
  Vault,
  type Vaults,
  type ArgonCurrentQueryClient,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import BitcoinLocks from '../BitcoinLocks.ts';
import type { BitcoinFissions } from '../BitcoinFissions.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import { BitcoinLocksTable } from '../db/BitcoinLocksTable.ts';
import { BitcoinLockResecuritize, type IBitcoinResecuritizationMetadata } from './BitcoinLock.resecuritize.ts';
import type { IBitcoinLiquidCreateFission } from './BitcoinLiquid.create.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface IBitcoinLiquidRatchetLockChange {
  lockId: number;
  phase: 'before-fissions' | 'after-fissions';
  securitizedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
}

export interface IBitcoinLiquidRatchetPreview {
  liquidId: number;
  fissionIds: number[];
  skippedFissionIds: number[];
  sourceLiquidity: bigint;
  newLiquidity: bigint;
  amountToMint: bigint;
  amountToBurn: bigint;
  lockChanges: IBitcoinLiquidRatchetLockChange[];
  errors: string[];
  canRatchet: boolean;
}

export interface IBitcoinLiquidRatchetMetadata {
  liquidId: number;
  fissionIds: number[];
  resecuritizedLockIds: number[];
  resecuritizations?: IBitcoinResecuritizationMetadata[];
  guaranteePurchases?: (Pick<IBitcoinLiquidCreateFission, 'fissionId' | 'lockId' | 'feeCouponRequestId'> & {
    securityFee: bigint;
  })[];
}

export interface BitcoinLiquidRatchetInput {
  liquidId: number;
  microgonsAtTargetPerBtc: bigint;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

type BitcoinLiquidRatchetBuild = TransactionOperationBuild<IBitcoinLiquidRatchetMetadata>;

export class BitcoinLiquidRatchet extends TransactionOperation<
  BitcoinLiquidRatchetInput,
  IBitcoinLiquidRatchetMetadata,
  BitcoinLiquidRatchetBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinRatchet;

  constructor(
    private readonly fissions: BitcoinFissions,
    transactionTracker: TransactionTracker,
    private readonly currency: Currency,
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly vaults: Vaults,
    private readonly bitcoinLockResecuritize: BitcoinLockResecuritize,
    private readonly upstreamOperatorClient: UpstreamOperatorClient,
    private readonly blockWatch: BlockWatch,
  ) {
    super(transactionTracker);
  }

  public async previewRatchet(
    liquidId: number,
    microgonsAtTargetPerBtc: bigint,
    client?: ArgonCurrentQueryClient,
    priceIndex = this.currency.priceIndex,
  ): Promise<IBitcoinLiquidRatchetPreview> {
    return (await this.loadRatchetPreview(liquidId, microgonsAtTargetPerBtc, client, priceIndex)).preview;
  }

  protected async build(args: BitcoinLiquidRatchetInput): Promise<BitcoinLiquidRatchetBuild> {
    const { liquidId, microgonsAtTargetPerBtc, txSigner, tip, client: providedClient } = args;
    if (txSigner.address !== this.fissions.ownerAccount) throw new Error('This Liquid belongs to a different account.');

    const client = providedClient ?? (await getMainchainClient(false));
    const { api: snapshotClient } = await this.blockWatch.getLatestFinalizedSnapshot();
    const priceIndex = await Currency.fetchPriceIndex(snapshotClient);
    const { preview, currentFissions, locksById, vaultsById } = await this.loadRatchetPreview(
      liquidId,
      microgonsAtTargetPerBtc,
      snapshotClient,
      priceIndex,
    );
    if (!preview.canRatchet) throw new Error(preview.errors[0] ?? 'No ratcheting is available for this Liquid.');

    const fissionsById = new Map(currentFissions.map(fission => [fission.fissionId, fission]));
    const ratchetFissions = preview.fissionIds
      .map(fissionId => fissionsById.get(fissionId))
      .filter((fission): fission is BitcoinFission => !!fission);
    if (ratchetFissions.length !== preview.fissionIds.length)
      throw new Error(`Liquid #${liquidId} changed before its ratchet could be submitted.`);

    const operatorHost = await this.upstreamOperatorClient.resolveOperatorHost();
    let currentCoupons: IBitcoinLockCouponStatus[] = [];
    if (operatorHost) currentCoupons = await this.upstreamOperatorClient.getBitcoinLockCoupons();
    const bitcoinTip = await snapshotClient.query.bitcoinUtxos.confirmedBitcoinBlockTip();
    const currentBitcoinHeight = bitcoinTip?.blockHeight ?? 0;
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(
      currentCoupons,
      ratchetFissions.map(fission => fission.lockId),
    );
    const claimedCouponRequestIds = new Set<string>();
    const metadata: IBitcoinLiquidRatchetMetadata = {
      liquidId,
      fissionIds: preview.fissionIds,
      resecuritizedLockIds: preview.lockChanges.map(change => change.lockId),
      resecuritizations: [],
      guaranteePurchases: [],
    };
    const beforeFissionTxs = [];
    const fissionTxs = [];
    const afterFissionTxs = [];
    let securityFee = 0n;
    for (const vault of vaultsById.values()) this.vaults.vaultsById[vault.vaultId] = vault;

    try {
      // Lock-backed guarantees must increase before any Fission changes and shrink only afterwards.
      const lockChanges = [
        ...preview.lockChanges.filter(change => change.phase === 'before-fissions'),
        ...preview.lockChanges.filter(change => change.phase === 'after-fissions'),
      ];
      for (const change of lockChanges) {
        const { lockId, securitizedSatoshis, microgonsAtTargetPerBtc } = change;
        const lock = this.bitcoinLocks.getLockById(lockId);
        const currentLock = locksById.get(lockId);
        if (!lock || !currentLock) throw new Error(`Bitcoin Lock #${lockId} is unavailable for this ratchet.`);
        const vault = vaultsById.get(currentLock.vaultId)!;
        const operatorCoupon = this.getCouponForLock(currentCoupons, vault.vaultId, lockId);
        const availableFeeCredit = operatorCoupon
          ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
          : 0n;
        const prepared = await this.bitcoinLockResecuritize.prepare({
          lock,
          vault,
          securitizedSatoshis,
          microgonsAtTargetPerBtc,
          txSigner,
          tip,
          operatorCoupon,
          client,
          priceIndex,
          currentBitcoinHeight,
          currentCoverageMicrogons: currentLock.cosignerGuarantee!.guaranteedMicrogons,
          maximumFeeCreditMicrogons: availableFeeCredit,
        });
        metadata.resecuritizations!.push(prepared.metadata);
        if (change.phase === 'before-fissions') beforeFissionTxs.push(prepared.tx);
        else afterFissionTxs.push(prepared.tx);
        securityFee += prepared.securityFee;
        if (operatorCoupon && txSigner.address !== vault.operatorAccountId) {
          const couponCredit = prepared.totalSecurityFee - prepared.securityFee;
          remainingFeeCreditByCouponId.set(operatorCoupon.coupon.id, bigIntMax(availableFeeCredit - couponCredit, 0n));
        }
      }

      for (const fission of ratchetFissions) {
        let feeCoupon;
        const replacement = fission.quoteGuaranteeReplacement({ priceIndex, microgonsAtTargetPerBtc });
        if (replacement) {
          const { guarantee, replacementCoverageMicrogons } = replacement;
          const lock = this.bitcoinLocks.getLockById(fission.lockId);
          const currentLock = locksById.get(fission.lockId);
          if (!lock?.scriptDetails || !currentLock)
            throw new Error(`Bitcoin Lock #${fission.lockId} is unavailable for this ratchet.`);
          const vault = vaultsById.get(currentLock.vaultId)!;
          const operatorCoupon = this.getCouponForLock(currentCoupons, vault.vaultId, fission.lockId);
          const availableFeeCredit = operatorCoupon
            ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
            : 0n;
          const feeQuote = BitcoinLockResecuritize.calculateFee({
            lock,
            vault,
            txSigner,
            operatorCoupon,
            satoshis: fission.satoshis,
            microgonsAtTargetPerBtc,
            currentCoverageMicrogons: guarantee.guaranteedMicrogons,
            replacementCoverageMicrogons,
            currentBitcoinHeight,
            maximumFeeCreditMicrogons: availableFeeCredit,
            claimedCouponRequestIds,
          });
          const purchase: NonNullable<IBitcoinLiquidRatchetMetadata['guaranteePurchases']>[number] = {
            fissionId: fission.fissionId,
            lockId: fission.lockId,
            securityFee: feeQuote.securityFee,
          };
          metadata.guaranteePurchases!.push(purchase);
          if (operatorCoupon && feeQuote.feeCouponRequest) {
            const response = await this.upstreamOperatorClient.initializeBitcoinLock(operatorCoupon.coupon.offerCode, {
              ...feeQuote.feeCouponRequest,
              requestId: feeQuote.feeCouponRequest.requestId ?? BitcoinLocksTable.createUuid(),
            });
            purchase.feeCouponRequestId = response.execution.requestId;
            claimedCouponRequestIds.add(response.execution.requestId);
            feeCoupon = response.execution.feeCoupon;
            purchase.securityFee = bigIntMax(feeQuote.totalSecurityFee - feeCoupon.feeDiscount, 0n);
          }
          securityFee += purchase.securityFee;
          if (operatorCoupon && txSigner.address !== vault.operatorAccountId) {
            const couponCredit = feeQuote.totalSecurityFee - purchase.securityFee;
            remainingFeeCreditByCouponId.set(
              operatorCoupon.coupon.id,
              bigIntMax(availableFeeCredit - couponCredit, 0n),
            );
          }
        }
        fissionTxs.push(
          BitcoinFission.createRatchetTx({ client, fissionId: fission.fissionId, microgonsAtTargetPerBtc, feeCoupon }),
        );
      }
    } catch (error) {
      await this.failGuaranteePurchases(metadata);
      throw error;
    }

    return {
      client,
      txs: [...beforeFissionTxs, ...fissionTxs, ...afterFissionTxs],
      txSigner,
      tip,
      unavailableBalance: preview.amountToBurn + securityFee,
      includeExistentialDeposit: true,
      metadata,
    };
  }

  protected matches(args: BitcoinLiquidRatchetInput, txInfo: TransactionInfo<IBitcoinLiquidRatchetMetadata>): boolean {
    return txInfo.tx.accountAddress === args.txSigner.address && txInfo.tx.metadataJson.liquidId === args.liquidId;
  }

  protected getOperationKey(args: BitcoinLiquidRatchetInput): string {
    return `${args.txSigner.address}:${args.liquidId}`;
  }

  public getPendingRatchetTxInfo(liquidId: number): TransactionInfo<IBitcoinLiquidRatchetMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.liquidId === liquidId);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLiquidRatchetMetadata>): Promise<void> {
    await txInfo.txResult.waitForFinalizedBlock;
    await this.transactionTracker.ensureStoredEvents(txInfo);
    for (const metadata of txInfo.tx.metadataJson.resecuritizations ?? []) {
      await this.bitcoinLockResecuritize.finalizeResecuritization(metadata, txInfo);
    }
    await this.fissions.recordFinalizedTransaction(txInfo);
    for (const { feeCouponRequestId } of txInfo.tx.metadataJson.guaranteePurchases ?? []) {
      if (feeCouponRequestId)
        await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Finalized');
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLiquidRatchetMetadata>): Promise<void> {
    await this.failGuaranteePurchases(txInfo.tx.metadataJson);
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLiquidRatchetMetadata, BitcoinLiquidRatchetBuild>,
  ): Promise<void> {
    await this.failGuaranteePurchases(prepared.metadata);
  }

  protected createInsufficientFundsError(
    _prepared: PreparedTransactionOperation<IBitcoinLiquidRatchetMetadata, BitcoinLiquidRatchetBuild>,
  ): Error {
    return new Error('Insufficient funds for this Liquid’s repayment, guarantee, and transaction fee.');
  }

  private async loadRatchetPreview(
    liquidId: number,
    microgonsAtTargetPerBtc: bigint,
    client?: ArgonCurrentQueryClient,
    priceIndex = this.currency.priceIndex,
  ): Promise<{
    preview: IBitcoinLiquidRatchetPreview;
    currentFissions: BitcoinFission[];
    locksById: Map<number, BitcoinLock>;
    vaultsById: Map<number, Vault>;
  }> {
    const queryClient = client ?? (await getMainchainClient(false));
    const currentFissions = await this.fissions.loadActive(queryClient);
    const liquidFissions = currentFissions.filter(fission => fission.liquidId === liquidId);
    if (!liquidFissions.length) throw new Error(`Liquid #${liquidId} is unavailable from current chain state.`);

    const minimumRatchetPercent = BigInt(
      queryClient.consts.bitcoinFissions.minimumRatchetPercent.times(100).toNumber(),
    );
    const errors: string[] = [];
    const lockIds = [...new Set(liquidFissions.map(fission => fission.lockId))];
    const [runtimeLocks, releaseRequests] = await Promise.all([
      queryClient.query.bitcoinLocks.locksById.multi(lockIds),
      Promise.all(lockIds.map(lockId => BitcoinLock.getReleaseRequest(queryClient, lockId))),
    ]);
    const vaultIds = [...new Set((runtimeLocks ?? []).flatMap(lock => (lock ? [lock.vaultId] : [])))];
    const vaults = await Promise.all(
      vaultIds.map(vaultId => Vault.get(queryClient, vaultId, NetworkConfig.tickMillis)),
    );
    const vaultsById = new Map(vaults.map(vault => [vault.vaultId, vault]));
    const locksById = new Map<number, BitcoinLock>();
    if (releaseRequests.some(Boolean)) {
      errors.push(
        "This Liquid's Bitcoin is updating internally. Ratchet will be available when the update is complete.",
      );
    }
    const eligibleFissions: BitcoinFission[] = [];
    const skippedFissionIds: number[] = [];
    let sourceLiquidity = 0n;
    let newLiquidity = 0n;
    let amountToMint = 0n;
    let amountToBurn = 0n;

    for (const fission of liquidFissions) {
      if (!fission.isRatchetAvailable({ microgonsAtTargetPerBtc, minimumRatchetPercent })) {
        skippedFissionIds.push(fission.fissionId);
        continue;
      }

      eligibleFissions.push(fission);
      const {
        sourceLiquidity: fissionSourceLiquidity,
        replacementLiquidity,
        amountMinted,
        amountBurned,
      } = fission.calculateRatchetAmounts({
        priceIndex,
        microgonsAtTargetPerBtc,
      });
      sourceLiquidity += fissionSourceLiquidity;
      newLiquidity += replacementLiquidity;
      amountToMint += amountMinted;
      amountToBurn += amountBurned;
    }

    if (!eligibleFissions.length) {
      errors.push(`No locked Bitcoin has reached the minimum ${minimumRatchetPercent}% price change.`);
    }

    eligibleFissions.sort((left, right) => {
      const leftIsDown = microgonsAtTargetPerBtc < left.microgonsAtTargetPerBtc;
      const rightIsDown = microgonsAtTargetPerBtc < right.microgonsAtTargetPerBtc;
      return Number(rightIsDown) - Number(leftIsDown);
    });

    const selectedFissionIds = new Set(eligibleFissions.map(fission => fission.fissionId));
    const remainingCapacityByVaultId = new Map<number, Vault>();
    const lockChanges: IBitcoinLiquidRatchetLockChange[] = [];

    for (const [index, lockId] of lockIds.entries()) {
      const runtimeLock = runtimeLocks?.[index];
      if (!runtimeLock) {
        errors.push(`Source lock #${lockId} is unavailable from current chain state.`);
        continue;
      }
      const lock = BitcoinLock.fromRuntime(lockId, runtimeLock);
      locksById.set(lockId, lock);
      const resecuritization = BitcoinLock.calculateResecuritizationForRatchet({
        lockId,
        lock: runtimeLock,
        lockFissions: currentFissions.filter(fission => fission.lockId === lockId),
        selectedFissionIds,
        microgonsAtTargetPerBtc,
        priceIndex,
      });
      if (!resecuritization) continue;

      lockChanges.push({
        lockId,
        phase: resecuritization.increasesGuarantee ? 'before-fissions' : 'after-fissions',
        securitizedSatoshis: resecuritization.satoshis,
        microgonsAtTargetPerBtc: resecuritization.microgonsAtTargetPerBtc,
      });
    }

    const orderedLockChanges = [
      ...lockChanges.filter(change => change.phase === 'before-fissions'),
      ...lockChanges.filter(change => change.phase === 'after-fissions'),
    ];
    for (const change of orderedLockChanges) {
      const lock = locksById.get(change.lockId)!;
      const vault = vaultsById.get(lock.vaultId)!;
      const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: change.securitizedSatoshis,
        microgonsAtTargetPerBtc: change.microgonsAtTargetPerBtc,
      });
      const capacity = BitcoinLock.calculateResecuritizationCapacity({
        lockId: change.lockId,
        lock: runtimeLocks[lockIds.indexOf(change.lockId)]!,
        vault: remainingCapacityByVaultId.get(vault.vaultId) ?? vault,
        securitizedSatoshis: change.securitizedSatoshis,
        replacementCoverageMicrogons,
      });
      if (!capacity.canAfford) {
        const vaultName = this.vaults.operatorNamesByVaultId[vault.vaultId] ?? 'The vault';
        errors.push(`${vaultName} does not have enough available securitization for this ratchet.`);
      }
      remainingCapacityByVaultId.set(vault.vaultId, capacity.projectedVault);
    }

    for (const fission of eligibleFissions) {
      const replacement = fission.quoteGuaranteeReplacement({ priceIndex, microgonsAtTargetPerBtc });
      if (!replacement) continue;
      const lock = locksById.get(fission.lockId);
      if (!lock) continue;
      const { guarantee, replacementCoverageMicrogons } = replacement;
      const vault = remainingCapacityByVaultId.get(lock.vaultId) ?? vaultsById.get(lock.vaultId)!;
      const projected = Object.assign(Object.create(Vault.prototype) as Vault, vault);
      projected.securitizationLocked -= guarantee.guaranteedMicrogons;
      if (lock.isFlexible) projected.flexibleSecuritizationLocked -= guarantee.guaranteedMicrogons;
      if (
        replacementCoverageMicrogons >
        projected.availableSecuritizationSpace(this.fissions.ownerAccount, lock.isFlexible)
      ) {
        const vaultName = this.vaults.operatorNamesByVaultId[vault.vaultId] ?? 'The vault';
        errors.push(`${vaultName} does not have enough available securitization for this ratchet.`);
      }
      projected.securitizationLocked += replacementCoverageMicrogons;
      if (lock.isFlexible) projected.flexibleSecuritizationLocked += replacementCoverageMicrogons;
      remainingCapacityByVaultId.set(vault.vaultId, projected);
    }

    return {
      preview: {
        liquidId,
        fissionIds: eligibleFissions.map(fission => fission.fissionId),
        skippedFissionIds,
        sourceLiquidity,
        newLiquidity,
        amountToMint,
        amountToBurn,
        lockChanges,
        errors,
        canRatchet: errors.length === 0,
      },
      currentFissions,
      locksById,
      vaultsById,
    };
  }

  private getCouponForLock(
    coupons: IBitcoinLockCouponStatus[],
    vaultId: number,
    lockId: number,
  ): IBitcoinLockCouponStatus | undefined {
    const resumableCoupon = coupons.find(coupon => {
      if (coupon.coupon.vaultId !== vaultId) return false;
      return coupon.uses?.some(use => use.status === 'Prepared' && use.utxoId === lockId && use.feeCoupon);
    });
    return resumableCoupon ?? coupons.find(coupon => coupon.coupon.vaultId === vaultId && coupon.status === 'Open');
  }

  private getAvailableFeeCreditByCouponId(
    coupons: IBitcoinLockCouponStatus[],
    plannedLockIds: number[],
  ): Map<number, bigint> {
    const planned = new Set(plannedLockIds);
    return new Map(
      coupons.map(coupon => {
        const resumableCredit =
          coupon.uses?.reduce((total, use) => {
            return use.status === 'Prepared' && use.feeCoupon && use.utxoId != null && planned.has(use.utxoId)
              ? total + use.feeCreditMicrogons
              : total;
          }, 0n) ?? 0n;
        return [coupon.coupon.id, (coupon.remainingFeeCreditMicrogons ?? 0n) + resumableCredit];
      }),
    );
  }

  private async failGuaranteePurchases(metadata: IBitcoinLiquidRatchetMetadata): Promise<void> {
    await Promise.all(
      (metadata.resecuritizations ?? []).map(purchase => this.bitcoinLockResecuritize.failResecuritization(purchase)),
    );
    for (const { feeCouponRequestId } of metadata.guaranteePurchases ?? []) {
      if (feeCouponRequestId)
        await this.upstreamOperatorClient.recordBitcoinLockFeeCouponUse(feeCouponRequestId, 'Failed');
    }
  }
}
