<template>
  <BitcoinLiquidCreationOverlay
    v-if="isOpen"
    :state="state"
    :liquid="completedLiquid"
    @close="close"
    @retry="retryTransaction"
    @amountChanged="queuePreview($event.satoshis)"
    @submit="submit($event.satoshis)"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntMax, bigIntMin } from '@argonprotocol/apps-core';

import basicEmitter from '../emitters/basicEmitter.ts';
import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
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

const isOpen = Vue.ref(false);
const isTrackingTransaction = Vue.ref(false);
const transactionInfo = Vue.shallowRef<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
const state = Vue.reactive<BitcoinLiquidCreationState>({
  stage: 'form',
  sources: [],
  isSubmitting: false,
  progressPct: 0,
  progressLabel: '',
  errorMessage: '',
  treasuryCertificationRequiredSatoshis: 0n,
});
const { isSubmitting, progressPct, progressLabel, errorMessage } = Vue.toRefs(state);
const selectedSatoshis = Vue.ref(0n);
const maximumSatoshisByUtxoId = Vue.ref<Record<number, bigint>>({});
const completedLiquidId = Vue.ref<number>();

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
const completedLiquid = Vue.computed<BitcoinLiquid | undefined>(() => {
  if (completedLiquidId.value === undefined) return;

  void bitcoinFissions.data.financialRevision;
  return bitcoinFissions.getLiquids().find(liquid => liquid.liquidId === completedLiquidId.value);
});

function open(options?: { liquidId: number }): void {
  if (options) {
    openPending(options.liquidId);
    return;
  }

  errorMessage.value = '';
  state.stage = 'form';
  state.preview = undefined;
  isSubmitting.value = false;
  isTrackingTransaction.value = false;
  transactionInfo.value = undefined;
  completedLiquidId.value = undefined;
  progressPct.value = 0;
  progressLabel.value = '';
  maximumSatoshisByUtxoId.value = Object.fromEntries(
    activeLocks.value
      .filter(lock => lock.utxoId != null)
      .map((lock, index) => [lock.utxoId!, lockAvailability.value[index].unallocatedSatoshis]),
  );
  selectedSatoshis.value = totalUnallocatedSatoshis.value;
  state.sources = createSourcesForAllocations(allocate(totalUnallocatedSatoshis.value));
  isOpen.value = true;
  void refreshCoupons();
  void refreshPreview(totalUnallocatedSatoshis.value);
}

function openPending(liquidId: number): void {
  const txInfo = pendingLiquidCreateTxInfos.value.find(candidate => candidate.tx.metadataJson.liquidId === liquidId);
  if (!txInfo) return;

  const { fissions } = txInfo.tx.metadataJson;
  const satoshis = fissions.reduce((total, fission) => total + fission.satoshis, 0n);
  state.sources = fissions.map(fission => {
    const lock = activeLocks.value.find(candidate => candidate.utxoId === fission.utxoId);
    return {
      key: lock?.uuid ?? `pending-liquid-${liquidId}-${fission.utxoId}`,
      isMyVault: lock?.vaultId === myVault.vaultId,
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
    if (isOpen.value && !isSubmitting.value && !transactionInfo.value) void refreshPreview(selectedSatoshis.value);
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
  let allocations = allocate(requestedSatoshis);
  if (!allocations.length) return false;
  errorMessage.value = '';

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
      if (runId !== previewRunId) return false;

      maximumSatoshisByUtxoId.value = {
        ...maximumSatoshisByUtxoId.value,
        ...error.maximumSatoshisByUtxoId,
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
      maximumSatoshisByUtxoId.value = {
        ...maximumSatoshisByUtxoId.value,
        ...error.maximumSatoshisByUtxoId,
      };
      await refreshPreview(satoshis);
    }
  }
}

function retryTransaction(): void {
  const txInfo = transactionInfo.value;
  if (txInfo?.hasFailedPostProcessing) {
    bitcoinLiquidCreate.resume(txInfo);
    trackCreateTransaction(txInfo);
    return;
  }

  cleanupTransactionProgress();
  transactionInfo.value = undefined;
  state.stage = 'form';
  isTrackingTransaction.value = false;
  progressPct.value = 0;
  progressLabel.value = '';
  errorMessage.value = '';
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
      if (txInfo.hasFailedPostProcessing) {
        errorMessage.value = `The Liquid was created on-chain, but the app could not finish updating it. ${error.message}`;
      }
    },
    onCleanup: cleanup => transactionProgressCleanupFns.push(cleanup),
  });
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
        isMyVault: lock.vaultId === myVault.vaultId,
        cosigner: vaults.operatorNamesByVaultId[lock.vaultId] ?? `Vault ${lock.vaultId}`,
        unallocatedSatoshis: lockAvailability.value[index].unallocatedSatoshis,
        maximumLiquidSatoshis:
          maximumSatoshisByUtxoId.value[lock.utxoId] ?? lockAvailability.value[index].unallocatedSatoshis,
        selectedSatoshis: selectedByUtxoId.get(lock.utxoId) ?? 0n,
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
  basicEmitter.off('openBitcoinLiquidCreationOverlay', open);
  if (previewTimeout) clearTimeout(previewTimeout);
  unsubscribeTicks?.();
  cleanupTransactionProgress();
});
</script>
