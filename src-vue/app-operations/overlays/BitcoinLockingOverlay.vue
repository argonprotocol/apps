<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="true"
    data-testid="BitcoinLockingOverlay"
    :data-e2e-state="lockStep"
    @close="closeOverlay"
    @esc="closeOverlay"
    class="BitcoinLockingOverlay min-h-60 w-240"
  >
    <template #title>
      <TooltipProvider v-if="isLoaded" :disableHoverableContent="true">
        <div class="mr-6 flex w-full flex-col gap-2">
          <div v-if="lockStep === LockStep.SelectVault">
            Select Vault for Locking
          </div>
          <div v-else class="flex w-full flex-row items-center">
            <TooltipRoot :delayDuration="100">
              <TooltipTrigger class="flex w-[calc(33.333333%+3rem)] flex-row items-center">
                <BitcoinIcon
                  :class="lockStep === LockStep.Start ? 'text-argon-600/80' : 'text-black/20'"
                  class="relative left-1 mr-2 h-10"
                />
                <div
                  :class="
                    lockStep === LockStep.Start
                      ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                      : 'border-slate-600/20 bg-white text-black/20'
                  "
                  class="relative grow border-y px-1 py-1 text-center text-base font-bold whitespace-nowrap"
                >
                  Specify Amount
                  <RoundCap class="absolute top-0 left-0" :isSelected="lockStep === LockStep.Start" />
                  <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="lockStep === LockStep.Start" />
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                :sideOffset="-10"
                align="start"
                :collisionPadding="9"
                class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl"
              >
                Choose how much BTC you want to lock. The more you lock, the more Argons you'll receive.
                <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
              </TooltipContent>
            </TooltipRoot>

            <TooltipRoot :delayDuration="100">
              <TooltipTrigger asChild>
                <Arrows
                  :class="lockStep === LockStep.IsProcessingOnArgon ? 'text-argon-600/80 processing-active' : 'text-black/10'"
                  class="ml-5 min-h-[34px] pr-3"
                />
              </TooltipTrigger>
              <TooltipContent
                :sideOffset="-7"
                :collisionPadding="9"
                side="bottom"
                align="center"
                class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl"
              >
                Your request is submitted to the Argon network and validated by participating miners.
                <TooltipArrow
                  :width="27"
                  :height="15"
                  class="-mt-px ml-4 fill-white stroke-gray-800/20 stroke-[0.5px]"
                />
              </TooltipContent>
            </TooltipRoot>

            <TooltipRoot :delayDuration="100">
              <TooltipTrigger asChild>
                <div
                  :class="
                    isLockBitcoinStep
                      ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                      : 'border-slate-600/20 bg-white text-black/20'
                  "
                  class="relative z-0 w-1/3 grow border-y px-1 py-1 text-center text-base font-bold whitespace-nowrap"
                >
                  Initiate Bitcoin
                  <RoundCap class="absolute top-0 left-0" :isSelected="isLockBitcoinStep" />
                  <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="isLockBitcoinStep" />
                </div>
              </TooltipTrigger>
              <TooltipContent
                :sideOffset="-7"
                :collisionPadding="9"
                side="bottom"
                align="center"
                class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl"
              >
                You must move your chosen Bitcoin amount to the multisig address provided by Argon.
                <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
              </TooltipContent>
            </TooltipRoot>

            <TooltipRoot :delayDuration="100">
              <TooltipTrigger asChild>
                <Arrows
                  :class="isLockToCollectTransition ? 'text-argon-600/80 processing-active' : 'text-black/10'"
                  class="ml-5 min-h-[34px] pr-3"
                />
              </TooltipTrigger>
              <TooltipContent
                :sideOffset="-7"
                :collisionPadding="9"
                side="bottom"
                align="center"
                class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl"
              >
                Argon will monitor the Bitcoin network to verify your multisig transaction completed.
                <TooltipArrow
                  :width="27"
                  :height="15"
                  class="-mt-px ml-4 fill-white stroke-gray-800/20 stroke-[0.5px]"
                />
              </TooltipContent>
            </TooltipRoot>

            <TooltipRoot :delayDuration="100">
              <TooltipTrigger asChild>
                <div
                  :class="
                    lockStep === LockStep.Minting
                      ? 'text-argon-600 border-argon-600 bg-slate-100'
                      : 'border-slate-600/20 bg-white text-black/20'
                  "
                  class="relative w-1/3 grow rounded-r border-y px-1 py-1 text-center text-base font-bold whitespace-nowrap"
                >
                  Collect Argons
                  <RoundCap class="absolute top-0 left-0" :isSelected="lockStep === LockStep.Minting" />
                  <RoundCap
                    :isSelected="lockStep === LockStep.Minting"
                    align="end"
                    class="absolute top-0 right-[2px]"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                :sideOffset="-7"
                align="end"
                :collisionPadding="9"
                class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-right leading-5.5 font-light text-slate-900/60 shadow-2xl"
              >
                You will be awarded the full market value of your Bitcoin as unencumbered Argon stablecoins.
                <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
              </TooltipContent>
            </TooltipRoot>
          </div>
        </div>
      </TooltipProvider>
    </template>

    <SelectAVault v-if="lockStep === LockStep.SelectVault" @load="handleVaultsLoaded" @select="handleVaultSelected" />
    <LockStart
      v-else-if="lockStep === LockStep.Start"
      :coupon="props.coupon"
      :currentTick="props.currentTick"
      :vault="vault as Vault"
      @close="closeOverlay"
      @lockCreated="onLockCreated" />
    <LockIsProcessingOnArgon v-else-if="lockStep === LockStep.IsProcessingOnArgon" :personalLock="personalLock!" />
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
  ReadyForBitcoin = 'ReadyForBitcoin',
  ProcessingOnBitcoin = 'ProcessingOnBitcoin',
  FundingMismatch = 'FundingMismatch',
  ExpiredFunding = 'ExpiredFunding',
  Minting = 'Minting',
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import LockStart from './bitcoin-locking/LockStart.vue';
import LockIsProcessingOnArgon from './bitcoin-locking/LockIsProcessingOnArgon.vue';
import LockReadyForBitcoin from './bitcoin-locking/LockReadyForBitcoin.vue';
import LockIsProcessingOnBitcoin from './bitcoin-locking/LockIsProcessingOnBitcoin.vue';
import LockFundingMismatch from './bitcoin-locking/LockFundingMismatch.vue';
import LockFundingExpired from './bitcoin-locking/LockFundingExpired.vue';
import LockMinting from './bitcoin-locking/LockMinting.vue';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import Arrows from '../../assets/arrows.svg?component';
import RoundCap from './bitcoin-locking/components/RoundCap.vue';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { Vault } from '@argonprotocol/mainchain';
import type { IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import SelectAVault from '../../components/SelectAVault.vue';

const bitcoinLocks = getBitcoinLocks();
const myVault = getMyVault();

const props = defineProps<{
  coupon?: IBitcoinLockCouponStatus;
  currentTick?: number;
  personalLock?: IBitcoinLockRecord;
  vault?: Vault;
}>();

const emit = defineEmits<{
  (e: 'close', shouldStartNewLocking: boolean): void;
}>();

const isLoaded = Vue.ref(false);
const hasDefaultVault = Vue.ref(!!props.vault);
const vault = Vue.ref<Vault | undefined>(props.vault);

const createdLockUuid = Vue.ref<string | undefined>();
const createdLock = Vue.ref<IBitcoinLockRecord | undefined>();
let overlayRefreshInterval: ReturnType<typeof setInterval> | undefined;

const trackedCreatedLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (!createdLockUuid.value) return undefined;

  const matchingLocks = bitcoinLocks.getAllLocks().filter(lock => lock.uuid === createdLockUuid.value);
  return matchingLocks.find(lock => lock.utxoId != null) ?? matchingLocks[0];
});

const personalLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  if (props.personalLock) return props.personalLock;

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
  if (props.personalLock || !createdLockUuid.value) return;
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

async function closeOverlay() {
  await acknowledgeExpiredIfNeeded();
  emit('close', false);
}

async function startNewLocking() {
  await acknowledgeExpiredIfNeeded();
  emit('close', true);
}

function handleVaultsLoaded() {}

function handleVaultSelected(v: Vault) {
  console.log('SELECTED VAULT = ', v);
  vault.value = v;
}

Vue.onMounted(() => {
  setTimeout(() => {
    isLoaded.value = true;
  }, 100);

  void resolveCreatedLockTransition();
  updateLockProcessingDetails();
  overlayRefreshInterval = setInterval(() => {
    void resolveCreatedLockTransition();
    updateLockProcessingDetails();
  }, 1_000);
});

Vue.watch(trackedCreatedLock, nextLock => {
  if (!nextLock) return;
  createdLock.value = nextLock;
});

Vue.watch(personalLock, updateLockProcessingDetails, { deep: true });

Vue.onUnmounted(() => {
  if (overlayRefreshInterval) {
    clearInterval(overlayRefreshInterval);
    overlayRefreshInterval = undefined;
  }
});
</script>

<style>
@reference "../../main.css";

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
