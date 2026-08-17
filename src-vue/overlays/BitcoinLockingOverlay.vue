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
      <StepsHeader :isLoading="isLoading" :hasError="!!vaultRefreshError" :icon="BitcoinIcon" :items="stepItems" />
    </template>

    <div v-if="isLoading" class="flex min-h-60 flex-col items-center justify-center gap-3 text-slate-500">
      <div class="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-argon-500" />
      <div>Loading...</div>
    </div>
    <div v-else-if="vaultRefreshError" class="flex min-h-60 flex-col items-center justify-center gap-4 px-8 text-center">
      <div class="text-lg font-semibold text-slate-800">Unable to refresh vault availability</div>
      <div class="text-sm text-slate-500">{{ vaultRefreshError }}</div>
      <div class="flex gap-3">
        <button class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600" @click="closeOverlay">Cancel</button>
        <button class="bg-argon-button rounded px-4 py-2 text-sm font-semibold text-white" @click="refreshVaultAvailability">
          Retry
        </button>
      </div>
    </div>
    <div v-else-if="lockStep === LockStep.SelectVault" class="px-2">
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
      :currentTick="currentTick"
      :vault="vault as Vault"
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
    <LockReadyForBitcoin
      v-else-if="lockStep === LockStep.ReadyForBitcoin"
      :personalLock="personalLock!"
      @close="closeOverlay"
    />
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
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getConfig } from '../stores/config.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { SATS_PER_BTC, Vault } from '@argonprotocol/mainchain';
import SelectAVault from '../components/SelectAVault.vue';
import StepsHeader, { IStepHeaderItem } from '../components/StepsHeader.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { useFinancials } from '../stores/financials.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { formatBtc } from '../lib/numeral.ts';

const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const financials = useFinancials();
const certificationController = useCertificationController();
const myVault = getMyVault();
const vaults = getVaults();
const miningFrames = getMiningFrames();

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(true);
const vaultRefreshError = Vue.ref('');
const currentTick = Vue.ref(0);
const requestedPersonalLock = Vue.ref<IBitcoinLockRecord>();
const tmpVault = Vue.ref<Vault>();
const vault = Vue.ref<Vault>();

const createdLockUuid = Vue.ref<string | undefined>();
const createdLock = Vue.ref<IBitcoinLockRecord | undefined>();
let overlayRefreshInterval: ReturnType<typeof setInterval> | undefined;
let unsubscribeTicks: VoidFunction | undefined;
let vaultRefreshKey = 0;
let isDisposed = false;

const defaultVault = Vue.computed(() => {
  const vaultId = myVault.vaultId;
  if (vaultId) return vaults.vaultsById[vaultId] ?? myVault.createdVault;

  const upstreamVaultId = config.upstreamOperator?.vaultId;
  if (upstreamVaultId) return vaults.vaultsById[upstreamVaultId];
});

const trackedCreatedLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (!createdLockUuid.value) return undefined;

  const matchingLocks = bitcoinLocks.getAllLocks().filter(lock => lock.uuid === createdLockUuid.value);
  return matchingLocks.find(lock => lock.utxoId != null) ?? matchingLocks[0];
});

const personalLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  const requestedLock = requestedPersonalLock.value;
  if (requestedLock) {
    if (requestedLock.utxoId == null) return requestedLock;
    return bitcoinLocks.getLockByUtxoId(requestedLock.utxoId) ?? requestedLock;
  }

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
  return (
    !certificationController.isTreasuryCertificationChecklistComplete &&
    !personalLock.value &&
    ownVaultId != null &&
    upstreamVaultId != null &&
    ownVaultId !== upstreamVaultId
  );
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

const operatorName = Vue.computed(() => (myVault.createdVault ? 'Yours' : config.upstreamOperator?.name));

const btcBeingLocked = Vue.computed(() => {
  const satoshis = personalLock.value?.satoshis;
  if (satoshis == null) return undefined;
  return Number(satoshis) / Number(SATS_PER_BTC);
});

const stepItems = Vue.computed<IStepHeaderItem[]>(() => [
  {
    label: 'Select Vault',
    value: operatorName.value,
    tooltip: 'Pick the vault you want to use for your liquid locking.',
    isActive: () => lockStep.value === LockStep.SelectVault,
    click: () => (canChangeVault.value ? changeVault() : undefined),
  },
  {
    label: '',
    tooltip: 'Your request is submitted to the Argon network and validated by participating miners.',
    isActive: () => false,
  },
  {
    label: 'Choose Amount',
    value: btcBeingLocked.value == null ? undefined : `${formatBtc(btcBeingLocked.value)} BTC`,
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
    value: lockStep.value === LockStep.Minting ? 'Locked' : undefined,
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
]);

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

  // Recheck the session after the database waits because the overlay can close or reopen for another lock.
  const lockUuid = createdLockUuid.value;
  const table = await bitcoinLocks.getTable();
  const utxoId = await table.getUtxoIdByUuid(lockUuid);
  if (utxoId == null) return;

  const finalizedLock = bitcoinLocks.getLockByUtxoId(utxoId) ?? (await table.getByUtxoId(utxoId));
  if (isDisposed || !isOpen.value || createdLockUuid.value !== lockUuid || !finalizedLock) return;

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
  vaultRefreshKey += 1;
  requestedPersonalLock.value = undefined;
  tmpVault.value = undefined;
  vault.value = undefined;
  createdLockUuid.value = undefined;
  createdLock.value = undefined;
  isLoading.value = false;
  vaultRefreshError.value = '';
  lockProcessingDetails.value = {
    progressPct: 0,
    confirmations: -1,
    expectedConfirmations: 0,
    mismatchDetected: false,
  };
}

function stopSessionRefresh() {
  if (overlayRefreshInterval) {
    clearInterval(overlayRefreshInterval);
    overlayRefreshInterval = undefined;
  }
}

function startSessionRefresh() {
  stopSessionRefresh();

  void resolveCreatedLockTransition();
  updateLockProcessingDetails();
  overlayRefreshInterval = setInterval(() => {
    void resolveCreatedLockTransition();
    updateLockProcessingDetails();
  }, 1_000);
}

async function refreshVaultAvailability() {
  const refreshKey = ++vaultRefreshKey;
  const vaultIds = [myVault.vaultId, config.upstreamOperator?.vaultId].filter(
    (vaultId): vaultId is number => vaultId != null,
  );
  isLoading.value = true;
  vaultRefreshError.value = '';
  try {
    await financials.refreshVaults([...new Set(vaultIds)]);
    if (refreshKey !== vaultRefreshKey || !isOpen.value) return;
    tmpVault.value = defaultVault.value;
    vault.value = defaultVault.value;
    startSessionRefresh();
  } catch (error) {
    if (refreshKey !== vaultRefreshKey || !isOpen.value) return;
    vaultRefreshError.value = error instanceof Error ? error.message : 'The vault refresh failed.';
  } finally {
    if (refreshKey === vaultRefreshKey) isLoading.value = false;
  }
}

function openOverlay(args?: { lock?: IBitcoinLockRecord }) {
  stopSessionRefresh();
  resetLockingSession();

  requestedPersonalLock.value = args?.lock;
  isLoading.value = !args?.lock;
  isOpen.value = true;
  if (args?.lock) {
    tmpVault.value = defaultVault.value;
    vault.value = defaultVault.value;
    startSessionRefresh();
  } else {
    void refreshVaultAvailability();
  }
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

  await miningFrames.load();
  // Runtime compatibility can dispose this overlay instance while loading; do not subscribe afterward.
  if (isDisposed) return;
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
  isDisposed = true;
  basicEmitter.off('openBitcoinLock', openOverlay);
  basicEmitter.off('closeAllOverlays', closeFromGlobalRequest);
  unsubscribeTicks?.();
  closeSession();
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
