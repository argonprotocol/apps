<template>
  <BitcoinLiquidCreationOverlay
    v-if="isOpen"
    :state="state"
    :liquid="completedLiquid"
    @close="close"
    @retry="retryTransaction"
    @chooseVaults="showVaultSelection"
    @refreshVaultCapacity="refreshVaultCapacity"
    @vaultsSelected="selectVaults($event.vaultIds)"
    @amountChanged="queuePreview($event.satoshis)"
    @submit="submit($event.satoshis)"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, bigIntMin, BitcoinFission, raceWithTimeout } from '@argonprotocol/apps-core';

import basicEmitter from '../emitters/basicEmitter.ts';
import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import { getTransactionFailureMessage, type TransactionInfo } from '../lib/TransactionInfo.ts';
import { trackTransactionProgress } from '../lib/TransactionProgress.ts';
import {
  BitcoinLiquidCreateStateChangedError,
  type BitcoinLiquidCreateAllocation,
  type IBitcoinLiquidCreateMetadata,
} from '../lib/txs/BitcoinLiquid.create.ts';
import {
  getBitcoinFissions,
  getBitcoinLockCoupons,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../stores/bitcoin.ts';
import {
  OperationalStepId,
  treasuryBitcoinCertificationDisplayAmount,
  useCertificationController,
} from '../stores/certificationController.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import BitcoinLiquidCreationOverlay from './BitcoinLiquidCreationOverlay.vue';
import type { BitcoinLiquidCreationState } from './BitcoinLiquidCreationState.ts';

const controller = useCertificationController();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const bitcoinLocks = getBitcoinLocks();
const bitcoinFissions = getBitcoinFissions();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();
const { bitcoinLiquidCreate } = getBitcoinTransactionOperations();
const myVault = getMyVault();
const PREVIEW_TIMEOUT_MS = 60_000;

const isOpen = Vue.ref(false);
const isTrackingTransaction = Vue.ref(false);
const transactionInfo = Vue.shallowRef<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
const state = Vue.reactive<BitcoinLiquidCreationState>({
  stage: 'form',
  sources: [],
  selectedVaultIds: [],
  isSubmitting: false,
  progressPct: 0,
  progressLabel: '',
  errorMessage: '',
  treasuryCertificationRequiredSatoshis: 0n,
});
const { isSubmitting, progressPct, progressLabel, errorMessage } = Vue.toRefs(state);
const selectedSatoshis = Vue.ref(0n);
const selectedVaultIds = Vue.ref(new Set<number>());
const maximumSatoshisByLockId = Vue.ref<Record<number, bigint>>({});
const completedLiquidId = Vue.ref<number>();

let previewTimeout: ReturnType<typeof setTimeout> | undefined;
let previewRunId = 0;
let vaultCapacityRunId = 0;
let couponRefreshRunId = 0;
let couponsAreCurrent = false;
let quoteTick: number | undefined;
let unsubscribeTicks: (() => void) | undefined;
let isUnmounted = false;
let transactionProgressCleanupFns: (() => void)[] = [];

const activeFissions = Vue.computed(() => bitcoinFissions.getAll());
const pendingLiquids = Vue.computed(() => bitcoinFissions.getPendingLiquids());
const pendingLiquidCreateTxInfos = Vue.computed(() => bitcoinLiquidCreate.getPendingLiquidTxInfos());
const activeLocks = Vue.computed(() =>
  bitcoinLocks.getAllLocks().filter(lock => lock.status === BitcoinLockStatus.LockFunded),
);
const allocatedSatoshisByLockId = Vue.computed(() => {
  const byLockId = new Map<IBitcoinLockRecord['lockId'], bigint>();
  const allocatedFissionIds = new Set<number>();
  for (const fission of activeFissions.value) {
    byLockId.set(fission.lockId, (byLockId.get(fission.lockId) ?? 0n) + fission.satoshis);
    allocatedFissionIds.add(fission.fissionId);
  }
  for (const liquid of pendingLiquids.value) {
    for (const fission of liquid.fissions) {
      if (allocatedFissionIds.has(fission.fissionId)) continue;
      byLockId.set(fission.lockId, (byLockId.get(fission.lockId) ?? 0n) + fission.satoshis);
      allocatedFissionIds.add(fission.fissionId);
    }
  }
  return byLockId;
});
const lockAvailability = Vue.computed(() =>
  activeLocks.value.map(lock => {
    const allocatedSatoshis = allocatedSatoshisByLockId.value.get(lock.lockId) ?? 0n;
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
const completedLiquid = Vue.computed<BitcoinLiquid | undefined>(() => {
  if (completedLiquidId.value === undefined) return;

  void bitcoinFissions.data.financialRevision;
  return bitcoinFissions.getLiquids().find(liquid => liquid.liquidId === completedLiquidId.value);
});

function open(options?: { liquidId: number }): void {
  previewRunId += 1;
  vaultCapacityRunId += 1;
  if (previewTimeout) clearTimeout(previewTimeout);
  state.vaultCapacity = undefined;
  if (options) {
    openPending(options.liquidId);
    return;
  }

  errorMessage.value = '';
  state.preview = undefined;
  isSubmitting.value = false;
  isTrackingTransaction.value = false;
  transactionInfo.value = undefined;
  completedLiquidId.value = undefined;
  progressPct.value = 0;
  progressLabel.value = '';
  maximumSatoshisByLockId.value = Object.fromEntries(
    activeLocks.value.flatMap((lock, index) =>
      lock.lockId == null ? [] : [[lock.lockId, lockAvailability.value[index].unallocatedSatoshis]],
    ),
  );
  selectedVaultIds.value = new Set(
    activeLocks.value
      .filter((_, index) => lockAvailability.value[index].unallocatedSatoshis > 0n)
      .map(lock => lock.vaultId),
  );
  state.selectedVaultIds = [...selectedVaultIds.value];
  state.stage = selectedVaultIds.value.size > 1 ? 'vaults' : 'form';
  selectedSatoshis.value = totalUnallocatedSatoshis.value;
  state.sources = createSourcesForAllocations(allocate(totalUnallocatedSatoshis.value));
  isOpen.value = true;
  void refreshCoupons();
  if (state.stage === 'form') void refreshPreview(totalUnallocatedSatoshis.value);
  else void refreshVaultCapacity();
}

function openPending(liquidId: number): void {
  const txInfo = pendingLiquidCreateTxInfos.value.find(candidate => candidate.tx.metadataJson.liquidId === liquidId);
  const liquid = pendingLiquids.value.find(candidate => candidate.liquidId === liquidId);
  if (!txInfo || !liquid) return;

  const fissions = liquid.fissions;
  const satoshis = fissions.reduce((total, fission) => total + fission.satoshis, 0n);
  state.sources = fissions.map(fission => {
    const lock = activeLocks.value.find(candidate => candidate.lockId === fission.lockId);
    return {
      key: lock?.uuid ?? `pending-liquid-${liquidId}-${fission.lockId}`,
      vaultId: lock?.vaultId ?? 0,
      vaultName:
        lock === undefined
          ? 'Unknown Vault'
          : lock.vaultId === myVault.vaultId
            ? 'Your Vault'
            : (vaults.operatorNamesByVaultId[lock.vaultId] ?? `Vault ${lock.vaultId}`),
      unallocatedSatoshis: fission.satoshis,
      maximumLiquidSatoshis: fission.satoshis,
      selectedSatoshis: fission.satoshis,
    };
  });
  selectedSatoshis.value = satoshis;
  selectedVaultIds.value = new Set(state.sources.map(source => source.vaultId));
  state.selectedVaultIds = [...selectedVaultIds.value];
  state.preview = undefined;
  progressPct.value = txInfo.getStatus().progressPct;
  progressLabel.value = '';
  errorMessage.value = '';
  completedLiquidId.value = undefined;
  isOpen.value = true;

  trackCreateTransaction(txInfo);
}

async function refreshCoupons(): Promise<void> {
  const runId = ++couponRefreshRunId;
  couponsAreCurrent = false;
  try {
    await bitcoinLockCoupons.refresh();
    if (runId !== couponRefreshRunId || isUnmounted) return;

    couponsAreCurrent = true;
    if (isOpen.value && state.stage === 'form' && !isSubmitting.value && !transactionInfo.value) {
      void refreshPreview(selectedSatoshis.value);
    }
  } catch (error) {
    if (runId !== couponRefreshRunId) return;
    console.warn('[BitcoinLiquid] Unable to refresh fee waivers', error);
  }
}

function queuePreview(satoshis: bigint): void {
  if (state.stage !== 'form') return;
  selectedSatoshis.value = satoshis;
  if (previewTimeout) clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    if (isOpen.value && state.stage === 'form') void refreshPreview(satoshis);
  }, 200);
}

function previewLiquid(allocations: BitcoinLiquidCreateAllocation[]) {
  return raceWithTimeout(
    (async () =>
      await bitcoinLiquidCreate.preview({
        allocations,
        txSigner: await walletKeys.getLiquidLockingKeypair(),
      }))(),
    PREVIEW_TIMEOUT_MS,
    () => {
      throw new Error('Checking available Bitcoin securitization timed out. Please retry.');
    },
  );
}

async function refreshPreview(requestedSatoshis: bigint): Promise<boolean> {
  const runId = ++previewRunId;
  let allocations = allocate(requestedSatoshis);
  if (!allocations.length) return false;
  errorMessage.value = '';

  try {
    let preview;
    try {
      preview = await previewLiquid(allocations);
    } catch (error) {
      if (!(error instanceof BitcoinLiquidCreateStateChangedError)) throw error;
      if (!Object.keys(error.maximumSatoshisByLockId).length) throw error;
      if (runId !== previewRunId) return false;

      maximumSatoshisByLockId.value = {
        ...maximumSatoshisByLockId.value,
        ...error.maximumSatoshisByLockId,
      };
      allocations = allocate(requestedSatoshis);
      selectedSatoshis.value = allocations.reduce((total, allocation) => total + allocation.satoshis, 0n);
      state.preview = undefined;
      state.sources = createSourcesForAllocations(allocations);
      if (!allocations.length) {
        const constrainedVaultIds = [
          ...new Set(
            state.sources
              .filter(source => source.maximumLiquidSatoshis === 0n)
              .map(source => activeLocks.value.find(lock => lock.uuid === source.key)?.vaultId)
              .filter((vaultId): vaultId is number => vaultId !== undefined),
          ),
        ];
        if (constrainedVaultIds.length === 1) {
          const vaultId = constrainedVaultIds[0];
          errorMessage.value =
            vaultId === myVault.vaultId
              ? 'Your Vault does not have enough securitization to create another Liquid.'
              : `${vaults.operatorNamesByVaultId[vaultId] ?? `Vault ${vaultId}`} does not have enough securitization to create another Liquid.`;
        } else {
          errorMessage.value = 'The selected vaults do not have enough securitization to create another Liquid.';
        }
        return false;
      }
      preview = await previewLiquid(allocations);
    }
    if (runId !== previewRunId) return false;

    maximumSatoshisByLockId.value = {
      ...maximumSatoshisByLockId.value,
      ...preview.maximumSatoshisByLockId,
    };
    selectedSatoshis.value = allocations.reduce((total, allocation) => total + allocation.satoshis, 0n);
    state.preview = preview;
    quoteTick = preview.microgonsAtTargetPerBtcTick;
    state.sources = createSourcesForAllocations(allocations);
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
    trackCreateTransaction(txInfo);
  } catch (error) {
    isSubmitting.value = false;
    errorMessage.value = error instanceof Error ? error.message : 'Unable to create this Liquid.';
    if (error instanceof BitcoinLiquidCreateStateChangedError) {
      maximumSatoshisByLockId.value = {
        ...maximumSatoshisByLockId.value,
        ...error.maximumSatoshisByLockId,
      };
      await refreshPreview(satoshis);
    }
  }
}

async function retryTransaction(): Promise<void> {
  const txInfo = transactionInfo.value;
  if (txInfo?.hasFailedPostProcessing && !getTransactionFailureMessage(txInfo)) {
    bitcoinLiquidCreate.resume(txInfo);
    trackCreateTransaction(txInfo);
    return;
  }

  if (txInfo) bitcoinFissions.discardPendingLiquid(txInfo.tx.metadataJson.liquidId);
  cleanupTransactionProgress();
  transactionInfo.value = undefined;
  state.stage = 'form';
  isTrackingTransaction.value = false;
  progressPct.value = 0;
  progressLabel.value = '';
  errorMessage.value = '';
  await refreshPreview(selectedSatoshis.value);
}

function showVaultSelection(): void {
  previewRunId += 1;
  if (previewTimeout) clearTimeout(previewTimeout);
  errorMessage.value = '';
  state.stage = 'vaults';
  void refreshVaultCapacity();
}

async function refreshVaultCapacity(): Promise<void> {
  const runId = ++vaultCapacityRunId;
  state.vaultCapacity = { ...state.vaultCapacity, status: 'loading', errorMessage: undefined };
  const allocations = activeLocks.value.flatMap((lock, index) => {
    const satoshis = lockAvailability.value[index].unallocatedSatoshis;
    return lock.lockId == null || satoshis === 0n ? [] : [{ lock, satoshis }];
  });

  try {
    let maximums: Readonly<Record<number, bigint>> = {};
    if (allocations.length) {
      try {
        const preview = await previewLiquid(allocations);
        maximums = preview.maximumSatoshisByLockId;
      } catch (error) {
        if (!(error instanceof BitcoinLiquidCreateStateChangedError)) throw error;
        if (!Object.keys(error.maximumSatoshisByLockId).length) throw error;
        maximums = error.maximumSatoshisByLockId;
      }
    }
    if (runId !== vaultCapacityRunId || !isOpen.value || state.stage !== 'vaults') return;

    maximumSatoshisByLockId.value = {
      ...maximumSatoshisByLockId.value,
      ...maximums,
    };
    const usableSatoshisByVaultId: Record<number, bigint> = {};
    for (const { lock, satoshis } of allocations) {
      const usableSatoshis = bigIntMin(satoshis, maximums[lock.lockId!] ?? 0n);
      usableSatoshisByVaultId[lock.vaultId] = (usableSatoshisByVaultId[lock.vaultId] ?? 0n) + usableSatoshis;
    }
    state.vaultCapacity = { status: 'ready', usableSatoshisByVaultId };
  } catch (error) {
    if (runId !== vaultCapacityRunId || !isOpen.value || state.stage !== 'vaults') return;
    state.vaultCapacity = {
      ...state.vaultCapacity,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : 'Unable to check vault securitization.',
    };
  }
}

function selectVaults(vaultIds: number[]): void {
  if (!vaultIds.length) return;
  vaultCapacityRunId += 1;
  selectedVaultIds.value = new Set(vaultIds);
  state.selectedVaultIds = vaultIds;
  const maximum = allocate(totalUnallocatedSatoshis.value).reduce(
    (total, allocation) => total + allocation.satoshis,
    0n,
  );
  selectedSatoshis.value = bigIntMin(selectedSatoshis.value, maximum);
  state.sources = createSourcesForAllocations(allocate(selectedSatoshis.value));
  state.preview = undefined;
  state.stage = 'form';
  void refreshPreview(selectedSatoshis.value);
}

function trackCreateTransaction(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): void {
  transactionInfo.value = txInfo;
  state.stage = 'creating';
  isSubmitting.value = false;
  cleanupTransactionProgress();
  trackTransactionProgress({
    txInfos: [txInfo],
    isSubmitting: isTrackingTransaction,
    progressPct,
    progressLabel,
    error: errorMessage,
    onComplete: () => showCollectArgons(txInfo.tx.metadataJson.liquidId),
    onError: error => {
      if (txInfo.hasFailedPostProcessing && !getTransactionFailureMessage(txInfo)) {
        errorMessage.value = `The Liquid was created on-chain, but the app could not finish updating it. ${error.message}`;
      }
    },
    onCleanup: cleanup => transactionProgressCleanupFns.push(cleanup),
  });
}

function allocate(satoshis: bigint): BitcoinLiquidCreateAllocation[] {
  const maximums = Object.fromEntries(
    activeLocks.value.flatMap((lock, index) =>
      lock.lockId == null
        ? []
        : [
            [
              lock.lockId,
              bigIntMin(
                lockAvailability.value[index].unallocatedSatoshis,
                maximumSatoshisByLockId.value[lock.lockId] ?? lockAvailability.value[index].unallocatedSatoshis,
              ),
            ],
          ],
    ),
  );
  return BitcoinFission.allocateSatoshis({
    locks: activeLocks.value,
    maximumSatoshisByLockId: maximums,
    selectedVaultIds: selectedVaultIds.value,
    requestedSatoshis: satoshis,
  }).map(({ lock, satoshis }) => {
    const operatorCoupon = couponsAreCurrent
      ? [bitcoinLockCoupons.currentCoupon, bitcoinLockCoupons.resumableCoupon].find(
          coupon => coupon?.coupon.vaultId === lock.vaultId,
        )
      : undefined;
    return { lock, satoshis, operatorCoupon };
  });
}

function createSourcesForAllocations(allocations: BitcoinLiquidCreateAllocation[]): IBitcoinLiquidSource[] {
  const selectedByLockId = new Map(allocations.map(allocation => [allocation.lock.lockId, allocation.satoshis]));
  return activeLocks.value.flatMap((lock, index) => {
    if (lock.lockId == null) return [];
    return [
      {
        key: lock.uuid,
        vaultId: lock.vaultId,
        vaultName:
          lock.vaultId === myVault.vaultId
            ? 'Your Vault'
            : (vaults.operatorNamesByVaultId[lock.vaultId] ?? `Vault ${lock.vaultId}`),
        unallocatedSatoshis: lockAvailability.value[index].unallocatedSatoshis,
        maximumLiquidSatoshis: bigIntMin(
          lockAvailability.value[index].unallocatedSatoshis,
          maximumSatoshisByLockId.value[lock.lockId] ?? lockAvailability.value[index].unallocatedSatoshis,
        ),
        selectedSatoshis: selectedByLockId.get(lock.lockId) ?? 0n,
      },
    ];
  });
}

function showCollectArgons(liquidId: number): void {
  completedLiquidId.value = liquidId;
  state.stage = 'complete';
  if (!completedLiquid.value) {
    errorMessage.value =
      'The Liquid was created, but its minting schedule is not available yet. Open it from Bitcoin Liquids when it appears.';
    return;
  }

  errorMessage.value = '';
}

async function updateTreasuryCertificationRequirement(rate: bigint): Promise<void> {
  if (isTreasuryCertified.value) {
    state.treasuryCertificationRequiredSatoshis = 0n;
    return;
  }
  const currentLiquidity = activeFissions.value.reduce((total, fission) => total + fission.liquidityPromised, 0n);
  const remainingLiquidity = bigIntMax(treasuryBitcoinCertificationDisplayAmount - currentLiquidity, 0n);
  state.treasuryCertificationRequiredSatoshis = remainingLiquidity
    ? await bitcoinLocks.satoshisForArgonLiquidity(remainingLiquidity, rate)
    : 0n;
}

function close(): void {
  previewRunId += 1;
  vaultCapacityRunId += 1;
  isOpen.value = false;
  errorMessage.value = '';
  completedLiquidId.value = undefined;
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
      state.stage !== 'form' ||
      isSubmitting.value ||
      !!transactionInfo.value ||
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
  previewRunId += 1;
  vaultCapacityRunId += 1;
  basicEmitter.off('openBitcoinLiquidCreationOverlay', open);
  if (previewTimeout) clearTimeout(previewTimeout);
  unsubscribeTicks?.();
  cleanupTransactionProgress();
});
</script>
