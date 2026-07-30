<!-- prettier-ignore -->
<template>
  <OverlayBase
    v-if="isOpen"
    :isOpen="true"
    data-testid="BitcoinLockingOverlay"
    :data-e2e-state="lockStep"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="BitcoinLockingOverlay min-h-60 w-240"
  >
    <template #title>
      <StepsHeader v-if="isLoaded" :icon="BitcoinIcon" :items="stepItems" />
    </template>

    <div v-if="lockStep === LockStep.SelectVault" class="px-2">
      <SelectAVault unitType="BitcoinLock" @load="handleVaultsLoaded" @select="handleVaultSelected" class="px-3" />
      <div class="flex flex-row justify-end gap-3 pt-3 px-3 mt-4 mb-3 border-t border-slate-300">
        <button
          type="button"
          class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 cursor-pointer hover:bg-slate-50"
          @click="closeOverlay"
        >
          Cancel
        </button>
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white cursor-pointer disabled:opacity-40"
          @click="finalizeVaultSelection"
        >
          Select Vault
        </button>
      </div>
    </div>
    <LockStart
      v-else-if="lockStep === LockStep.Start"
      :canChangeVault="canChangeVault"
      :coupon="bitcoinLockCoupons.currentCoupon"
      :currentTick="currentTick"
      :vault="vault as Vault"
      @changeVault="changeVault"
      @close="closeOverlay"
      @lockCreated="onLockCreated" />
    <LockIsProcessingOnArgon v-else-if="lockStep === LockStep.IsProcessingOnArgon" :personalLock="personalLock!" />
    <div v-else-if="lockStep === LockStep.Failed" class="flex flex-col px-5 pt-6 pb-8">
      <div class="flex flex-row items-center justify-center">
        <div class="flex flex-col items-center justify-center">
          <div class="text-2xl font-bold">Error</div>
          <div class="text-sm text-gray-500">
            {{ lockFailedError || 'The Argon transaction failed before this Bitcoin lock was created.' }}
          </div>
        </div>
      </div>
      <div class="mt-6 flex justify-end border-t border-slate-200 pt-4">
        <button
          data-testid="BitcoinLockingOverlay.acknowledgeFailed()"
          type="button"
          class="cursor-pointer rounded-md border border-slate-400 px-5 py-2 text-base font-semibold text-slate-700 hover:bg-slate-100"
          @click="acknowledgeFailedAndDismiss"
        >
          Acknowledge &amp; Dismiss
        </button>
      </div>
    </div>
    <LockReadyForBitcoin v-else-if="lockStep === LockStep.ReadyForBitcoin" :personalLock="personalLock!" />
    <LockIsProcessingOnBitcoin v-else-if="lockStep === LockStep.ProcessingOnBitcoin" :personalLock="personalLock!" />
    <LockFundingMismatch v-else-if="lockStep === LockStep.FundingMismatch" :personalLock="personalLock!" />
    <LockFundingExpired
      v-else-if="lockStep === LockStep.ExpiredFunding"
      :personalLock="personalLock!"
      @startNew="startNewLocking" />
    <LockMinting v-else-if="lockStep === LockStep.Minting" :personalLock="personalLock!" @close="closeOverlay" />
  </OverlayBase>
</template>

<script lang="ts">
enum LockStep {
  SelectVault = 'SelectVault',
  Start = 'Start',
  IsProcessingOnArgon = 'IsProcessingOnArgon',
  Failed = 'Failed',
  ReadyForBitcoin = 'ReadyForBitcoin',
  ProcessingOnBitcoin = 'ProcessingOnBitcoin',
  FundingMismatch = 'FundingMismatch',
  ExpiredFunding = 'ExpiredFunding',
  Minting = 'Minting',
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import LockStart from './bitcoin-locking/LockStart.vue';
import LockIsProcessingOnArgon from './bitcoin-locking/LockIsProcessingOnArgon.vue';
import LockReadyForBitcoin from './bitcoin-locking/LockReadyForBitcoin.vue';
import LockIsProcessingOnBitcoin from './bitcoin-locking/LockIsProcessingOnBitcoin.vue';
import LockFundingMismatch from './bitcoin-locking/LockFundingMismatch.vue';
import LockFundingExpired from './bitcoin-locking/LockFundingExpired.vue';
import LockMinting from './bitcoin-locking/LockMinting.vue';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../stores/bitcoin.ts';
import { getConfig } from '../stores/config.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { Vault } from '@argonprotocol/mainchain';
import SelectAVault from '../components/SelectAVault.vue';
import StepsHeader, { IStepHeaderItem } from '../components/StepsHeader.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getMiningFrames } from '../stores/mainchain.ts';

const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();
const myVault = getMyVault();
const vaults = getVaults();
const miningFrames = getMiningFrames();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const currentTick = Vue.ref(0);
const requestedPersonalLock = Vue.ref<IBitcoinLockRecord>();
const tmpVault = Vue.ref<Vault>();
const vault = Vue.ref<Vault>();

const createdLockUuid = Vue.ref<string | undefined>();
const createdLock = Vue.ref<IBitcoinLockRecord | undefined>();
let overlayRefreshInterval: ReturnType<typeof setInterval> | undefined;
let headerLoadTimeout: ReturnType<typeof setTimeout> | undefined;
let unsubscribeTicks: VoidFunction | undefined;

const defaultVault = Vue.computed(() => {
  const upstreamVaultId = config.upstreamOperator?.vaultId;
  if (upstreamVaultId) return vaults.vaultsById[upstreamVaultId];

  const vaultId = myVault.vaultId;
  if (vaultId) return myVault.createdVault ?? vaults.vaultsById[vaultId];

  const couponVaultId = bitcoinLockCoupons.currentCoupon?.coupon.vaultId;
  return couponVaultId ? vaults.vaultsById[couponVaultId] : undefined;
});

const trackedCreatedLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (!createdLockUuid.value) return undefined;

  const matchingLocks = bitcoinLocks.getAllLocks().filter(lock => lock.uuid === createdLockUuid.value);
  return matchingLocks.find(lock => lock.utxoId != null) ?? matchingLocks[0];
});

const personalLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (requestedPersonalLock.value) return requestedPersonalLock.value;

  if (trackedCreatedLock.value) {
    return trackedCreatedLock.value;
  }

  if (createdLock.value?.utxoId != null) {
    return bitcoinLocks.getLockByUtxoId(createdLock.value.utxoId) ?? createdLock.value;
  }

  // During pending->finalized transition, keep the last known record while the finalized
  // utxo-backed record is still being wired back into the overlay.
  return createdLock.value;
});

const lockProcessingDetails = Vue.ref({
  progressPct: 0,
  confirmations: -1,
  expectedConfirmations: 0,
  mismatchDetected: false,
});

const mismatchView = Vue.computed(() => {
  if (!personalLock.value) return undefined;
  return bitcoinLocks.getMismatchViewState(personalLock.value);
});

const canChangeVault = Vue.computed(() => {
  const ownVaultId = myVault.vaultId;
  const upstreamVaultId = config.upstreamOperator?.vaultId;
  return !personalLock.value && ownVaultId != null && upstreamVaultId != null && ownVaultId !== upstreamVaultId;
});

const lockStep = Vue.computed<LockStep>(() => {
  const lock = personalLock.value;

  if (!lock && !vault.value) {
    return LockStep.SelectVault;
  } else if (!lock || bitcoinLocks.isInactiveForVaultDisplay(lock)) {
    console.log('VAULT = ', vault.value);
    return LockStep.Start;
  }

  if (lock.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
    return LockStep.IsProcessingOnArgon;
  }

  if (lock.status === BitcoinLockStatus.LockFailed) {
    return LockStep.Failed;
  }

  if (bitcoinLocks.isFundingReadyToResumeStatus(lock) || mismatchView.value?.phase !== 'none') {
    return LockStep.FundingMismatch;
  }

  if (bitcoinLocks.isFundingExpiredStatus(lock)) {
    return LockStep.ExpiredFunding;
  }

  if (lock.status === BitcoinLockStatus.LockPendingFunding) {
    if (bitcoinLocks.hasObservedFundingSignal(lock) || lockProcessingDetails.value.confirmations >= 0) {
      return LockStep.ProcessingOnBitcoin;
    }
    return LockStep.ReadyForBitcoin;
  }

  return LockStep.Minting;
});

const isLockBitcoinStep = Vue.computed(() => {
  return (
    lockStep.value === LockStep.ReadyForBitcoin ||
    lockStep.value === LockStep.ProcessingOnBitcoin ||
    lockStep.value === LockStep.FundingMismatch ||
    lockStep.value === LockStep.ExpiredFunding
  );
});

const isLockToCollectTransition = Vue.computed(() => {
  return lockStep.value === LockStep.ProcessingOnBitcoin;
});

const lockFailedError = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return '';
  return bitcoinLocks.getLockProcessingError(lock);
});

const stepItems: IStepHeaderItem[] = [
  {
    label: 'Select Vault',
    tooltip: "Choose how much BTC you want to lock. The more you lock, the more Argons you'll receive.",
    isActive: () => lockStep.value === LockStep.SelectVault,
  },
  {
    label: '',
    tooltip: 'Your request is submitted to the Argon network and validated by participating miners.',
    isActive: () => false,
  },
  {
    label: 'Choose Amount',
    tooltip: "Choose how much BTC you want to lock. The more you lock, the more Argons you'll receive.",
    isActive: () => lockStep.value === LockStep.Start,
  },
  {
    label: '',
    tooltip: 'Your request is submitted to the Argon network and validated by participating miners.',
    isActive: () => lockStep.value === LockStep.IsProcessingOnArgon || lockStep.value === LockStep.Failed,
  },
  {
    label: 'Lock Bitcoin',
    tooltip: 'You must move your chosen Bitcoin amount to the multisig address provided by Argon.',
    isActive: () => isLockBitcoinStep.value,
  },

  {
    label: '',
    tooltip: 'Argon will monitor the Bitcoin network to verify your multisig transaction completed.',
    isActive: () => isLockToCollectTransition.value,
  },
  {
    label: 'Collect Argons',
    tooltip: 'You will be awarded the full market value of your Bitcoin as unencumbered Argon stablecoins.',
    isActive: () => lockStep.value === LockStep.Minting,
  },
];

function updateLockProcessingDetails() {
  const lock = personalLock.value;
  if (!lock || !bitcoinLocks.isLockProcessingStatus(lock)) {
    lockProcessingDetails.value = {
      progressPct: 0,
      confirmations: -1,
      expectedConfirmations: 0,
      mismatchDetected: false,
    };
    return;
  }

  const details = bitcoinLocks.getLockProcessingDetails(lock);
  lockProcessingDetails.value = {
    progressPct: details.progressPct,
    confirmations: details.confirmations,
    expectedConfirmations: details.expectedConfirmations,
    mismatchDetected: details.isInvalidAmount === true,
  };
}

function onLockCreated(lock: IBitcoinLockRecord) {
  createdLockUuid.value = lock.uuid;
  createdLock.value = lock;
}

async function resolveCreatedLockTransition() {
  if (requestedPersonalLock.value || !createdLockUuid.value) return;
  if (trackedCreatedLock.value?.utxoId != null) return;

  const table = await bitcoinLocks.getTable();
  const utxoId = await table.getUtxoIdByUuid(createdLockUuid.value);
  if (utxoId == null) return;

  const finalizedLock = bitcoinLocks.getLockByUtxoId(utxoId) ?? (await table.getByUtxoId(utxoId));
  if (!finalizedLock) return;

  createdLock.value = finalizedLock;
}

async function acknowledgeExpiredIfNeeded() {
  const lock = personalLock.value;
  if (!lock || lock.status !== BitcoinLockStatus.LockExpiredWaitingForFunding) return;
  await bitcoinLocks.acknowledgeExpiredWaitingForFunding(lock).catch(() => undefined);
}

async function acknowledgeFailedIfNeeded() {
  const lock = personalLock.value;
  if (!lock || lock.status !== BitcoinLockStatus.LockFailed) return;
  await bitcoinLocks.acknowledgeFailed(lock).catch(() => undefined);
}

async function closeOverlay() {
  await acknowledgeExpiredIfNeeded();
  await acknowledgeFailedIfNeeded();
  closeSession();
}

async function startNewLocking() {
  await acknowledgeExpiredIfNeeded();
  await acknowledgeFailedIfNeeded();
  closeSession();
  void Vue.nextTick(() => openOverlay());
}

async function acknowledgeFailedAndDismiss() {
  await acknowledgeFailedIfNeeded();
  closeSession();
}

function handleVaultsLoaded() {}

function handleVaultSelected(v: Vault) {
  tmpVault.value = v;
}

function finalizeVaultSelection() {
  vault.value = tmpVault.value;
}

function changeVault() {
  vault.value = undefined;
}

function resetLockingSession() {
  requestedPersonalLock.value = undefined;
  tmpVault.value = undefined;
  vault.value = undefined;
  createdLockUuid.value = undefined;
  createdLock.value = undefined;
  isLoaded.value = false;
  lockProcessingDetails.value = {
    progressPct: 0,
    confirmations: -1,
    expectedConfirmations: 0,
    mismatchDetected: false,
  };
}

function stopSessionRefresh() {
  if (headerLoadTimeout) {
    clearTimeout(headerLoadTimeout);
    headerLoadTimeout = undefined;
  }
  if (overlayRefreshInterval) {
    clearInterval(overlayRefreshInterval);
    overlayRefreshInterval = undefined;
  }
}

function startSessionRefresh() {
  stopSessionRefresh();
  headerLoadTimeout = setTimeout(() => {
    isLoaded.value = true;
  }, 100);

  void resolveCreatedLockTransition();
  updateLockProcessingDetails();
  overlayRefreshInterval = setInterval(() => {
    void resolveCreatedLockTransition();
    updateLockProcessingDetails();
  }, 1_000);
}

function openOverlay(args?: { lock?: IBitcoinLockRecord }) {
  stopSessionRefresh();
  resetLockingSession();

  requestedPersonalLock.value = args?.lock;
  tmpVault.value = defaultVault.value;
  vault.value = defaultVault.value;
  isOpen.value = true;
  startSessionRefresh();
}

function closeSession() {
  isOpen.value = false;
  stopSessionRefresh();
  resetLockingSession();
}

function closeFromGlobalRequest() {
  closeSession();
}

Vue.onMounted(async () => {
  basicEmitter.on('openBitcoinLock', openOverlay);
  basicEmitter.on('closeAllOverlays', closeFromGlobalRequest);
  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });

  await miningFrames.load();
  currentTick.value = miningFrames.currentTick;
  unsubscribeTicks = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;
});

Vue.watch(trackedCreatedLock, nextLock => {
  if (!nextLock) return;
  createdLock.value = nextLock;
});

Vue.watch(personalLock, updateLockProcessingDetails, { deep: true });

Vue.onUnmounted(() => {
  basicEmitter.off('openBitcoinLock', openOverlay);
  basicEmitter.off('closeAllOverlays', closeFromGlobalRequest);
  unsubscribeTicks?.();
  stopSessionRefresh();
});
</script>

<style>
@reference "../main.css";

.BitcoinLockingOverlay {
  .processing-active #arrows polygon {
    opacity: 0.3;
    transition: opacity 0.2s ease-in-out;
  }

  .processing-active .arrow1 {
    transform-origin: center;
    animation: bitcoin-locking-overlay-arrows-pulse 1.2s ease-in-out infinite;
  }

  .processing-active .arrow2 {
    transform-origin: center;
    animation: bitcoin-locking-overlay-arrows-pulse 1.2s ease-in-out infinite 0.2s;
  }

  .processing-active .arrow3 {
    transform-origin: center;
    animation: bitcoin-locking-overlay-arrows-pulse 1.2s ease-in-out infinite 0.4s;
  }
}

@keyframes bitcoin-locking-overlay-arrows-pulse {
  0%,
  100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.3);
  }
}
</style>
