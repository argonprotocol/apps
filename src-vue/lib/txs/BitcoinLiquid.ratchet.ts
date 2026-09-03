import {
  bigIntMax,
  bigIntMin,
  BitcoinFission,
  BitcoinLock,
  Currency,
  type IBitcoinLockCouponStatus,
  NetworkConfig,
  type ArgonClient,
  type TxSigningAccount,
  Vault,
  type Vaults,
  type ArgonQueryClient,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import BitcoinLocks from '../BitcoinLocks.ts';
import type { BitcoinFissions } from '../BitcoinFissions.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import type { BitcoinLockResecuritize, IBitcoinResecuritizationMetadata } from './BitcoinLock.resecuritize.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface IBitcoinLiquidRatchetLockChange {
  utxoId: number;
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
  resecuritizedUtxoIds: number[];
  resecuritizations?: IBitcoinResecuritizationMetadata[];
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
  ) {
    super(transactionTracker);
  }

  public async previewRatchet(
    liquidId: number,
    microgonsAtTargetPerBtc: bigint,
    client?: ArgonQueryClient,
    priceIndex = this.currency.priceIndex,
  ): Promise<IBitcoinLiquidRatchetPreview> {
    return (await this.loadRatchetPreview(liquidId, microgonsAtTargetPerBtc, client, priceIndex)).preview;
  }

  protected async build(args: BitcoinLiquidRatchetInput): Promise<BitcoinLiquidRatchetBuild> {
    const { liquidId, microgonsAtTargetPerBtc, txSigner, tip, client: providedClient } = args;
    const client = providedClient ?? (await getMainchainClient(false));
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const snapshotClient = await client.at(finalizedHead);
    const priceIndex = await Currency.fetchPriceIndex(snapshotClient);
    const { preview, currentFissions } = await this.loadRatchetPreview(
      liquidId,
      microgonsAtTargetPerBtc,
      snapshotClient,
      priceIndex,
    );
    if (!preview.canRatchet) throw new Error(preview.errors[0] ?? 'No ratcheting is available for this Liquid.');

    const beforeFissions = preview.lockChanges.filter(change => change.phase === 'before-fissions');
    const afterFissions = preview.lockChanges.filter(change => change.phase === 'after-fissions');
    const fissionsById = new Map(currentFissions.map(fission => [fission.fissionId, fission]));
    const ratchetFissions = preview.fissionIds
      .map(fissionId => fissionsById.get(fissionId))
      .filter((fission): fission is BitcoinFission => !!fission)
      .sort((left, right) => {
        const leftIsDown = microgonsAtTargetPerBtc < left.microgonsAtTargetPerBtc;
        const rightIsDown = microgonsAtTargetPerBtc < right.microgonsAtTargetPerBtc;
        return Number(rightIsDown) - Number(leftIsDown);
      });
    if (ratchetFissions.length !== preview.fissionIds.length) {
      throw new Error(`Liquid #${liquidId} changed before its ratchet could be submitted.`);
    }

    const [bitcoinTip, currentCoupons] = await Promise.all([
      snapshotClient.query.bitcoinUtxos.confirmedBitcoinBlockTip(),
      this.upstreamOperatorClient.getBitcoinLockCoupons(),
    ]);
    const currentBitcoinHeight = bitcoinTip?.blockHeight ?? 0;
    const resecuritizations: IBitcoinResecuritizationMetadata[] = [];
    const remainingCoverageByVaultId = new Map<number, bigint>();
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(
      currentCoupons,
      preview.lockChanges.map(({ utxoId }) => utxoId),
    );
    let securityFee = 0n;

    let beforeFissionTxs;
    let afterFissionTxs;
    try {
      beforeFissionTxs = await this.prepareResecuritizations({
        changes: beforeFissions,
        client,
        snapshotClient,
        priceIndex,
        currentBitcoinHeight,
        currentCoupons,
        remainingFeeCreditByCouponId,
        remainingCoverageByVaultId,
        txSigner,
        tip,
        resecuritizations,
        onSecurityFee: fee => (securityFee += fee),
      });
      afterFissionTxs = await this.prepareResecuritizations({
        changes: afterFissions,
        client,
        snapshotClient,
        priceIndex,
        currentBitcoinHeight,
        currentCoupons,
        remainingFeeCreditByCouponId,
        remainingCoverageByVaultId,
        txSigner,
        tip,
        resecuritizations,
        onSecurityFee: fee => (securityFee += fee),
      });
    } catch (error) {
      await this.failResecuritizations(resecuritizations);
      throw error;
    }

    const calls = [
      ...beforeFissionTxs,
      ...ratchetFissions.map(fission =>
        BitcoinFission.createRatchetTx({
          client,
          fissionId: fission.fissionId,
          microgonsAtTargetPerBtc,
        }),
      ),
      ...afterFissionTxs,
    ];
    const metadata: IBitcoinLiquidRatchetMetadata = {
      liquidId,
      fissionIds: preview.fissionIds,
      resecuritizedUtxoIds: preview.lockChanges.map(change => change.utxoId),
      resecuritizations,
    };

    return {
      client,
      txs: calls,
      txSigner,
      metadata,
      tip,
      unavailableBalance: preview.amountToBurn + securityFee,
      includeExistentialDeposit: true,
    };
  }

  private async loadRatchetPreview(
    liquidId: number,
    microgonsAtTargetPerBtc: bigint,
    client?: ArgonQueryClient,
    priceIndex = this.currency.priceIndex,
  ): Promise<{ preview: IBitcoinLiquidRatchetPreview; currentFissions: BitcoinFission[] }> {
    const queryClient = client ?? (await getMainchainClient(false));
    const currentFissions = await this.fissions.loadActive(queryClient);
    const liquidFissions = currentFissions.filter(fission => fission.liquidId === liquidId);
    if (!liquidFissions.length) throw new Error(`Liquid #${liquidId} is unavailable from current chain state.`);

    const minimumRatchetPercent = queryClient.consts.bitcoinFissions.minimumRatchetPercent.toBigInt();
    const errors: string[] = [];
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

    const lockChanges = await this.getLockChanges({
      client: queryClient,
      liquidFissions: eligibleFissions,
      microgonsAtTargetPerBtc,
      priceIndex,
      errors,
      currentFissions,
    });

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
    const blockHash = await txInfo.txResult.waitForFinalizedBlock;
    await Promise.all(
      (txInfo.tx.metadataJson.resecuritizations ?? []).map(metadata =>
        this.bitcoinLockResecuritize.finalizeResecuritization(metadata, blockHash),
      ),
    );
    await this.fissions.load();
    await this.transactionTracker.ensureStoredEvents(txInfo);
    await this.fissions.recordFinalizedTransaction(txInfo);
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLiquidRatchetMetadata>): Promise<void> {
    await this.failResecuritizations(txInfo.tx.metadataJson.resecuritizations ?? []);
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLiquidRatchetMetadata, BitcoinLiquidRatchetBuild>,
  ): Promise<void> {
    await this.failResecuritizations(prepared.metadata.resecuritizations ?? []);
  }

  protected createInsufficientFundsError(
    _prepared: PreparedTransactionOperation<IBitcoinLiquidRatchetMetadata, BitcoinLiquidRatchetBuild>,
  ): Error {
    return new Error('Insufficient funds to repay this Liquid and submit its ratchet.');
  }

  private async getLockChanges(args: {
    client: ArgonQueryClient;
    liquidFissions: BitcoinFission[];
    microgonsAtTargetPerBtc: bigint;
    priceIndex: PriceIndex;
    errors: string[];
    currentFissions: BitcoinFission[];
  }): Promise<IBitcoinLiquidRatchetLockChange[]> {
    const { client, liquidFissions, microgonsAtTargetPerBtc, priceIndex, errors, currentFissions } = args;
    const selectedFissionIds = new Set(liquidFissions.map(fission => fission.fissionId));
    const utxoIds = [...new Set(liquidFissions.map(fission => fission.utxoId))];
    const locks = await BitcoinLock.getMany(client, utxoIds);
    const lockChanges: IBitcoinLiquidRatchetLockChange[] = [];
    const remainingCoverageByVaultId = new Map<number, bigint>();

    for (let index = 0; index < utxoIds.length; index += 1) {
      const utxoId = utxoIds[index];
      const lock = locks[index];
      if (!lock) {
        errors.push(`Source lock #${utxoId} is unavailable from current chain state.`);
        continue;
      }

      const lockFissions = currentFissions.filter(fission => fission.utxoId === utxoId);
      let requiredLiquidity = 0n;
      let requiredRate = 0n;
      for (const fission of lockFissions) {
        const rate = selectedFissionIds.has(fission.fissionId)
          ? microgonsAtTargetPerBtc
          : fission.microgonsAtTargetPerBtc;
        const liquidity = selectedFissionIds.has(fission.fissionId)
          ? BitcoinLock.calculateLiquidityPromised({
              priceIndex,
              satoshis: fission.satoshis,
              microgonsAtTargetPerBtc: rate,
            })
          : fission.liquidityPromised;
        requiredLiquidity += liquidity;
        if (rate > requiredRate) requiredRate = rate;
      }

      const securitizedSatoshis = findSatoshisForCoverage({
        minimumSatoshis: lock.fissionedSatoshis,
        microgonsAtTargetPerBtc: requiredRate,
        requiredLiquidity,
        priceIndex,
      });
      if (securitizedSatoshis === lock.securitizedSatoshis && requiredRate === lock.microgonsAtTargetPerBtc) {
        continue;
      }

      const needsMoreSecurity =
        securitizedSatoshis > lock.securitizedSatoshis || requiredRate > lock.microgonsAtTargetPerBtc;
      if (needsMoreSecurity) {
        const vault = await Vault.get(client, lock.vaultId, NetworkConfig.tickMillis);
        const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: securitizedSatoshis,
          microgonsAtTargetPerBtc: requiredRate,
        });
        const additionalCoverageMicrogons = bigIntMax(
          replacementCoverageMicrogons - lock.securitizationCoverageMicrogons,
          0n,
        );
        const remainingCoverage =
          remainingCoverageByVaultId.get(vault.vaultId) ?? vault.availableBitcoinSpace(this.fissions.ownerAccount);
        if (additionalCoverageMicrogons > remainingCoverage) {
          const cosigner = this.vaults.operatorNamesByVaultId[vault.vaultId] ?? 'The cosigner';
          errors.push(`${cosigner} does not have enough available insurance for this ratchet.`);
        } else {
          remainingCoverageByVaultId.set(vault.vaultId, remainingCoverage - additionalCoverageMicrogons);
        }
      }
      lockChanges.push({
        utxoId,
        phase: needsMoreSecurity ? 'before-fissions' : 'after-fissions',
        securitizedSatoshis,
        microgonsAtTargetPerBtc: requiredRate,
      });
    }

    return lockChanges;
  }

  private async prepareResecuritizations(args: {
    changes: IBitcoinLiquidRatchetLockChange[];
    client: ArgonClient;
    snapshotClient: ArgonQueryClient;
    priceIndex: PriceIndex;
    currentBitcoinHeight: number;
    currentCoupons: IBitcoinLockCouponStatus[];
    remainingFeeCreditByCouponId: Map<number, bigint>;
    remainingCoverageByVaultId: Map<number, bigint>;
    txSigner: TxSigningAccount;
    tip?: bigint;
    resecuritizations: IBitcoinResecuritizationMetadata[];
    onSecurityFee: (fee: bigint) => void;
  }) {
    const {
      changes,
      client,
      snapshotClient,
      priceIndex,
      currentBitcoinHeight,
      currentCoupons,
      remainingFeeCreditByCouponId,
      remainingCoverageByVaultId,
      txSigner,
      tip,
      resecuritizations,
      onSecurityFee,
    } = args;
    const txs = [];
    const table = await this.bitcoinLocks.getTable();

    for (const change of changes) {
      const { utxoId, securitizedSatoshis, microgonsAtTargetPerBtc } = change;
      const lock = this.bitcoinLocks.getLockByUtxoId(utxoId);
      const currentLock = await BitcoinLock.get(snapshotClient, utxoId);
      if (!lock || !currentLock) throw new Error(`Bitcoin Lock #${utxoId} is unavailable for this ratchet.`);

      const vault = await Vault.get(snapshotClient, currentLock.vaultId, NetworkConfig.tickMillis);
      this.vaults.vaultsById[vault.vaultId] = vault;
      const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: securitizedSatoshis,
        microgonsAtTargetPerBtc,
      });
      const additionalCoverageMicrogons = bigIntMax(
        replacementCoverageMicrogons - currentLock.securitizationCoverageMicrogons,
        0n,
      );
      const remainingCoverage =
        remainingCoverageByVaultId.get(vault.vaultId) ?? vault.availableBitcoinSpace(txSigner.address);
      if (additionalCoverageMicrogons > remainingCoverage) {
        const cosigner = this.vaults.operatorNamesByVaultId[vault.vaultId] ?? 'The cosigner';
        throw new Error(`${cosigner} does not have enough available insurance for this ratchet.`);
      }
      remainingCoverageByVaultId.set(vault.vaultId, remainingCoverage - additionalCoverageMicrogons);

      await table.setCurrentLockFunded(lock, currentLock);
      const operatorCoupon = this.getCouponForLock(currentCoupons, currentLock.vaultId, utxoId);
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
        maximumFeeCreditMicrogons: availableFeeCredit,
      });
      if (operatorCoupon) {
        remainingFeeCreditByCouponId.set(
          operatorCoupon.coupon.id,
          bigIntMax(availableFeeCredit - (prepared.totalSecurityFee - prepared.securityFee), 0n),
        );
      }
      txs.push(prepared.tx);
      resecuritizations.push(prepared.metadata);
      onSecurityFee(prepared.securityFee);
    }

    return txs;
  }

  private getCouponForLock(
    coupons: IBitcoinLockCouponStatus[],
    vaultId: number,
    utxoId: number,
  ): IBitcoinLockCouponStatus | undefined {
    const resumableCoupon = coupons.find(coupon => {
      if (coupon.coupon.vaultId !== vaultId) return false;
      return coupon.uses?.some(use => use.status === 'Prepared' && use.utxoId === utxoId && use.feeCoupon);
    });
    return resumableCoupon ?? coupons.find(coupon => coupon.coupon.vaultId === vaultId && coupon.status === 'Open');
  }

  private getAvailableFeeCreditByCouponId(
    coupons: IBitcoinLockCouponStatus[],
    plannedUtxoIds: number[],
  ): Map<number, bigint> {
    const planned = new Set(plannedUtxoIds);
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

  private async failResecuritizations(resecuritizations: IBitcoinResecuritizationMetadata[]): Promise<void> {
    await Promise.all(resecuritizations.map(metadata => this.bitcoinLockResecuritize.failResecuritization(metadata)));
  }
}

function findSatoshisForCoverage(args: {
  minimumSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  requiredLiquidity: bigint;
  priceIndex: PriceIndex;
}): bigint {
  const { minimumSatoshis, microgonsAtTargetPerBtc, requiredLiquidity, priceIndex } = args;
  const calculateLiquidityPromised = (satoshis: bigint) =>
    BitcoinLock.calculateLiquidityPromised({
      priceIndex,
      satoshis,
      microgonsAtTargetPerBtc,
    });
  if (calculateLiquidityPromised(minimumSatoshis) >= requiredLiquidity) {
    return minimumSatoshis;
  }

  let lower = minimumSatoshis;
  let upper = minimumSatoshis || 1n;
  while (calculateLiquidityPromised(upper) < requiredLiquidity) {
    lower = upper;
    upper *= 2n;
  }
  while (lower + 1n < upper) {
    const middle = (lower + upper) / 2n;
    if (calculateLiquidityPromised(middle) >= requiredLiquidity) upper = middle;
    else lower = middle;
  }
  return upper;
}
