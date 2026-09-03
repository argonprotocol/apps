<template>
  <BitcoinLiquidCreationOverlay
    v-if="isOpen"
    :sources="sources"
    :feeMicrogons="feeMicrogons"
    :liquidityMicrogons="liquidityMicrogons"
    :projectedEarningsMicrogons="projectedEarningsMicrogons"
    :couponCreditMicrogons="couponCreditMicrogons"
    :feeGiftProvider="config.upstreamOperator?.name"
    :isSubmitting="isSubmitting"
    :progressPct="progressPct"
    :progressLabel="progressLabel"
    :availableWalletMicrogons="wallets.defaultArgonSpendableMicrogons"
    :isTreasuryCertified="isTreasuryCertified"
    :treasuryCertificationRequiredSatoshis="treasuryCertificationRequiredSatoshis"
    :microgonsAtTargetPerBtc="microgonsAtTargetPerBtc"
    :errorMessage="errorMessage"
    @close="close"
    @amountChanged="queuePreview($event.satoshis)"
    @submit="submit($event.satoshis)"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';

import basicEmitter from '../emitters/basicEmitter.ts';
import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { trackTransactionProgress } from '../lib/TransactionProgress.ts';
import {
  BitcoinLiquidCreateStateChangedError,
  type BitcoinLiquidCreateAllocation,
} from '../lib/txs/BitcoinLiquid.create.ts';
import {
  getBitcoinFissions,
  getBitcoinLockCoupons,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../stores/bitcoin.ts';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { getVaults } from '../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import BitcoinLiquidCreationOverlay from './BitcoinLiquidCreationOverlay.vue';

const config = getConfig();
const controller = useCertificationController();
const vaultingStats = useVaultingStats();
const vaults = getVaults();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const bitcoinLocks = getBitcoinLocks();
const bitcoinFissions = getBitcoinFissions();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();
const { bitcoinLiquidCreate } = getBitcoinTransactionOperations();

const isOpen = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const sources = Vue.ref<IBitcoinLiquidSource[]>([]);
const feeMicrogons = Vue.ref(0n);
const liquidityMicrogons = Vue.ref(0n);
const couponCreditMicrogons = Vue.ref(0n);
const projectedEarningsMicrogons = Vue.ref(0n);
const microgonsAtTargetPerBtc = Vue.ref<bigint>();
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('');
const errorMessage = Vue.ref('');
const selectedSatoshis = Vue.ref(0n);
const maximumSatoshisByUtxoId = Vue.ref<Record<number, bigint>>({});
const treasuryCertificationRequiredSatoshis = Vue.ref(0n);

let previewTimeout: ReturnType<typeof setTimeout> | undefined;
let previewRunId = 0;
let couponRefreshRunId = 0;
let couponsAreCurrent = false;
let quoteTick: number | undefined;
let unsubscribeTicks: (() => void) | undefined;
let isUnmounted = false;
let transactionProgressCleanupFns: (() => void)[] = [];

const activeFissions = Vue.computed(() => bitcoinFissions.getAll());
const pendingLiquidCreateTxInfos = Vue.computed(() => bitcoinLiquidCreate.getPendingLiquidTxInfos());
const activeLocks = Vue.computed(() =>
  bitcoinLocks.getAllLocks().filter(lock => lock.status === BitcoinLockStatus.LockFunded),
);
const allocatedSatoshisByUtxoId = Vue.computed(() => {
  const byUtxoId = new Map<IBitcoinLockRecord['utxoId'], bigint>();
  const allocatedFissionIds = new Set<number>();
  for (const fission of activeFissions.value) {
    byUtxoId.set(fission.utxoId, (byUtxoId.get(fission.utxoId) ?? 0n) + fission.satoshis);
    allocatedFissionIds.add(fission.fissionId);
  }
  for (const txInfo of pendingLiquidCreateTxInfos.value) {
    for (const fission of txInfo.tx.metadataJson.fissions) {
      if (allocatedFissionIds.has(fission.fissionId)) continue;
      byUtxoId.set(fission.utxoId, (byUtxoId.get(fission.utxoId) ?? 0n) + fission.satoshis);
      allocatedFissionIds.add(fission.fissionId);
    }
  }
  return byUtxoId;
});
const lockAvailability = Vue.computed(() =>
  activeLocks.value.map(lock => {
    const allocatedSatoshis = allocatedSatoshisByUtxoId.value.get(lock.utxoId) ?? 0n;
    const unallocatedSatoshis = bigIntMax(lock.fundedSatoshis - allocatedSatoshis, 0n);
    const unallocatedSecuritizedSatoshis = bigIntMax(lock.securitizedSatoshis - allocatedSatoshis, 0n);
    return {
      unallocatedSatoshis,
      readySatoshis: bigIntMin(unallocatedSatoshis, unallocatedSecuritizedSatoshis),
    };
  }),
);
const totalUnallocatedSatoshis = Vue.computed(() =>
  lockAvailability.value.reduce((total, lock) => total + lock.unallocatedSatoshis, 0n),
);
const isTreasuryCertified = Vue.computed(() => controller.isCertificationStepComplete(OperationalStepId.LiquidLock));

function open(options?: { liquidId: number }): void {
  if (options) {
    openPending(options.liquidId);
    return;
  }

  errorMessage.value = '';
  progressPct.value = 0;
  progressLabel.value = '';
  maximumSatoshisByUtxoId.value = Object.fromEntries(
    activeLocks.value
      .filter(lock => lock.utxoId != null)
      .map((lock, index) => [lock.utxoId!, lockAvailability.value[index].unallocatedSatoshis]),
  );
  selectedSatoshis.value = totalUnallocatedSatoshis.value;
  sources.value = createSourcesForAllocations(allocate(totalUnallocatedSatoshis.value));
  isOpen.value = true;
  void refreshCoupons();
  void refreshPreview(totalUnallocatedSatoshis.value);
}

function openPending(liquidId: number): void {
  const txInfo = pendingLiquidCreateTxInfos.value.find(candidate => candidate.tx.metadataJson.liquidId === liquidId);
  if (!txInfo) return;

  const { fissions, resecuritizations } = txInfo.tx.metadataJson;
  const satoshis = fissions.reduce((total, fission) => total + fission.satoshis, 0n);
  const promised = fissions.reduce(
    (total, fission) => total + (fission.satoshis * fission.microgonsAtTargetPerBtc) / SATOSHIS_PER_BITCOIN,
    0n,
  );
  const insuranceFees = resecuritizations.reduce(
    (total, resecuritization) => total + resecuritization.bitcoin.securityFee,
    0n,
  );

  sources.value = fissions.map(fission => {
    const lock = activeLocks.value.find(candidate => candidate.utxoId === fission.utxoId);
    return {
      key: lock?.uuid ?? `pending-liquid-${liquidId}-${fission.utxoId}`,
      cosigner:
        lock === undefined
          ? 'Unknown cosigner'
          : (vaults.operatorNamesByVaultId[lock.vaultId] ?? `Vault ${lock.vaultId}`),
      unallocatedSatoshis: fission.satoshis,
      maximumLiquidSatoshis: fission.satoshis,
      selectedSatoshis: fission.satoshis,
    };
  });
  selectedSatoshis.value = satoshis;
  feeMicrogons.value = insuranceFees + (txInfo.tx.txFeePlusTip ?? 0n);
  liquidityMicrogons.value = promised;
  couponCreditMicrogons.value = 0n;
  projectedEarningsMicrogons.value = bigNumberToBigInt(
    BigNumber(promised.toString()).multipliedBy(vaultingStats.bitcoinAPR).dividedBy(100),
  );
  microgonsAtTargetPerBtc.value = fissions[0]?.microgonsAtTargetPerBtc;
  progressPct.value = txInfo.getStatus().progressPct;
  progressLabel.value = '';
  errorMessage.value = '';
  isOpen.value = true;

  cleanupTransactionProgress();
  trackTransactionProgress({
    txInfos: [txInfo],
    isSubmitting,
    progressPct,
    progressLabel,
    error: errorMessage,
    onComplete: close,
    onCleanup: cleanup => transactionProgressCleanupFns.push(cleanup),
  });
}

async function refreshCoupons(): Promise<void> {
  const runId = ++couponRefreshRunId;
  couponsAreCurrent = false;
  try {
    await bitcoinLockCoupons.refresh();
    if (runId !== couponRefreshRunId || isUnmounted) return;

    couponsAreCurrent = true;
    if (isOpen.value && !isSubmitting.value) void refreshPreview(selectedSatoshis.value);
  } catch (error) {
    if (runId !== couponRefreshRunId) return;
    console.warn('[BitcoinLiquid] Unable to refresh fee waivers', error);
  }
}

function queuePreview(satoshis: bigint): void {
  selectedSatoshis.value = satoshis;
  if (previewTimeout) clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => void refreshPreview(satoshis), 200);
}

async function refreshPreview(requestedSatoshis: bigint): Promise<boolean> {
  const runId = ++previewRunId;
  errorMessage.value = '';
  let allocations = allocate(requestedSatoshis);
  if (!allocations.length) return false;

  try {
    let preview;
    try {
      preview = await bitcoinLiquidCreate.preview({
        allocations,
        txSigner: await walletKeys.getLiquidLockingKeypair(),
      });
    } catch (error) {
      if (!(error instanceof BitcoinLiquidCreateStateChangedError)) throw error;
      if (!Object.keys(error.maximumSatoshisByUtxoId).length) throw error;

      maximumSatoshisByUtxoId.value = {
        ...maximumSatoshisByUtxoId.value,
        ...error.maximumSatoshisByUtxoId,
      };
      allocations = allocate(requestedSatoshis);
      preview = await bitcoinLiquidCreate.preview({
        allocations,
        txSigner: await walletKeys.getLiquidLockingKeypair(),
      });
    }
    if (runId !== previewRunId) return false;

    maximumSatoshisByUtxoId.value = {
      ...maximumSatoshisByUtxoId.value,
      ...preview.maximumSatoshisByUtxoId,
    };
    selectedSatoshis.value = allocations.reduce((total, allocation) => total + allocation.satoshis, 0n);
    microgonsAtTargetPerBtc.value = preview.microgonsAtTargetPerBtc;
    quoteTick = preview.microgonsAtTargetPerBtcTick;
    feeMicrogons.value = preview.securityFeeMicrogons;
    liquidityMicrogons.value = preview.liquidityMicrogons;
    couponCreditMicrogons.value = preview.couponCreditMicrogons;
    projectedEarningsMicrogons.value = bigNumberToBigInt(
      BigNumber(preview.liquidityMicrogons.toString()).multipliedBy(vaultingStats.bitcoinAPR).dividedBy(100),
    );
    sources.value = createSourcesForAllocations(allocations);
    await updateTreasuryCertificationRequirement(preview.microgonsAtTargetPerBtc);
    return true;
  } catch (error) {
    if (runId === previewRunId) {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to refresh Liquid terms.';
    }
    return false;
  }
}

async function submit(satoshis: bigint): Promise<void> {
  if (isSubmitting.value) return;

  isSubmitting.value = true;
  errorMessage.value = '';
  try {
    await refreshPreview(satoshis);
    if (errorMessage.value) {
      isSubmitting.value = false;
      return;
    }
    const txInfo = await bitcoinLiquidCreate.submit({
      allocations: allocate(selectedSatoshis.value),
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    cleanupTransactionProgress();
    trackTransactionProgress({
      txInfos: [txInfo],
      isSubmitting,
      progressPct,
      progressLabel,
      error: errorMessage,
      onComplete: close,
      onCleanup: cleanup => transactionProgressCleanupFns.push(cleanup),
    });
  } catch (error) {
    isSubmitting.value = false;
    errorMessage.value = error instanceof Error ? error.message : 'Unable to create this Liquid.';
    if (error instanceof BitcoinLiquidCreateStateChangedError) {
      maximumSatoshisByUtxoId.value = {
        ...maximumSatoshisByUtxoId.value,
        ...error.maximumSatoshisByUtxoId,
      };
      await refreshPreview(satoshis);
    }
  }
}

function allocate(satoshis: bigint): BitcoinLiquidCreateAllocation[] {
  let remaining = satoshis;
  const allocations: BitcoinLiquidCreateAllocation[] = [];
  for (const [index, lock] of activeLocks.value.entries()) {
    if (lock.utxoId == null || remaining <= 0n) continue;
    const maximum = bigIntMin(
      lockAvailability.value[index].unallocatedSatoshis,
      maximumSatoshisByUtxoId.value[lock.utxoId] ?? lockAvailability.value[index].unallocatedSatoshis,
    );
    const selected = bigIntMin(maximum, remaining);
    if (selected <= 0n) continue;
    const operatorCoupon = couponsAreCurrent
      ? [bitcoinLockCoupons.currentCoupon, bitcoinLockCoupons.resumableCoupon].find(
          coupon => coupon?.coupon.vaultId === lock.vaultId,
        )
      : undefined;
    allocations.push({ lock, satoshis: selected, operatorCoupon });
    remaining -= selected;
  }
  return allocations;
}

function createSourcesForAllocations(allocations: BitcoinLiquidCreateAllocation[]): IBitcoinLiquidSource[] {
  const selectedByUtxoId = new Map(allocations.map(allocation => [allocation.lock.utxoId, allocation.satoshis]));
  return activeLocks.value.flatMap((lock, index) => {
    if (lock.utxoId == null) return [];
    return [
      {
        key: lock.uuid,
        cosigner: vaults.operatorNamesByVaultId[lock.vaultId] ?? `Vault ${lock.vaultId}`,
        unallocatedSatoshis: lockAvailability.value[index].unallocatedSatoshis,
        maximumLiquidSatoshis:
          maximumSatoshisByUtxoId.value[lock.utxoId] ?? lockAvailability.value[index].unallocatedSatoshis,
        selectedSatoshis: selectedByUtxoId.get(lock.utxoId) ?? 0n,
      },
    ];
  });
}

async function updateTreasuryCertificationRequirement(rate: bigint): Promise<void> {
  if (isTreasuryCertified.value) {
    treasuryCertificationRequiredSatoshis.value = 0n;
    return;
  }
  const currentLiquidity = activeFissions.value.reduce((total, fission) => total + fission.liquidityPromised, 0n);
  const remainingLiquidity = bigIntMax(controller.rewardConfig.treasuryMinimumBitcoin - currentLiquidity, 0n);
  treasuryCertificationRequiredSatoshis.value = remainingLiquidity
    ? await bitcoinLocks.satoshisForArgonLiquidity(remainingLiquidity, rate)
    : 0n;
}

function close(): void {
  isOpen.value = false;
  errorMessage.value = '';
  if (previewTimeout) clearTimeout(previewTimeout);
}

function cleanupTransactionProgress(): void {
  transactionProgressCleanupFns.forEach(cleanup => cleanup());
  transactionProgressCleanupFns = [];
}

Vue.onMounted(async () => {
  basicEmitter.on('openBitcoinLiquidCreationOverlay', open);
  await miningFrames.load();
  if (isUnmounted) return;
  unsubscribeTicks = miningFrames.onTick(() => {
    if (
      !isOpen.value ||
      isSubmitting.value ||
      !selectedSatoshis.value ||
      (quoteTick !== undefined && miningFrames.currentTick - quoteTick < 10)
    ) {
      return;
    }
    void refreshPreview(selectedSatoshis.value);
  }).unsubscribe;
});

Vue.onUnmounted(() => {
  isUnmounted = true;
  basicEmitter.off('openBitcoinLiquidCreationOverlay', open);
  if (previewTimeout) clearTimeout(previewTimeout);
  unsubscribeTicks?.();
  cleanupTransactionProgress();
});
</script>
