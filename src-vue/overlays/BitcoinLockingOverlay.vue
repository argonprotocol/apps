<template>
  <Overlay :isOpen="true" @close="closeOverlay" @esc="closeOverlay" class="BitcoinLockingOverlay min-h-60 w-240">
    <template #title>
      <div v-if="isLoaded" class="mr-6 flex w-full flex-row items-center">
        <TooltipRoot v-if="shouldShowFullProcess" :delayDuration="100">
          <TooltipTrigger class="flex w-[calc(33.333333%+3rem)] flex-row items-center">
            <BitcoinIcon
              :class="lockStep === LockStep.Start ? 'text-argon-600/80' : 'text-black/20'"
              class="relative left-1 mr-2 h-10" />
            <div
              :class="
                lockStep === LockStep.Start
                  ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative grow border-y px-2 py-1 text-center text-base font-bold">
              Choose Amount
              <RoundCap class="absolute top-0 left-0" :isSelected="lockStep === LockStep.Start" />
              <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="lockStep === LockStep.Start" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="start"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl">
            Choose how much BTC you want to lock. The more you lock, the more Argons you'll receive.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot v-if="shouldShowFullProcess" :delayDuration="100">
          <TooltipTrigger asChild>
            <Arrows
              :class="
                lockStep === LockStep.IsProcessingOnArgon ? 'text-argon-600/80 processing-active' : 'text-black/10'
              "
              class="ml-5 min-h-[34px] pr-3" />
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl">
            Your request is submitted to the Argon network and validated by participating miners.
            <TooltipArrow :width="27" :height="15" class="-mt-px ml-4 fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <BitcoinIcon
              v-if="!shouldShowFullProcess"
              :class="lockStep === LockStep.Start ? 'text-argon-600/80' : 'text-black/20'"
              class="relative left-1 mr-2 h-10" />
            <div
              :class="
                lockStep === LockStep.ReadyForBitcoin
                  ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative z-0 w-1/3 grow border-y px-2 py-1 text-center text-base font-bold">
              Lock Bitcoin
              <RoundCap class="absolute top-0 left-0" :isSelected="lockStep === LockStep.ReadyForBitcoin" />
              <RoundCap
                align="end"
                class="absolute top-0 right-[2px]"
                :isSelected="lockStep === LockStep.ReadyForBitcoin" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl">
            You must move your chosen Bitcoin amount to the multisig address provided by Argon.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <Arrows
              :class="
                lockStep === LockStep.ProcessingOnBitcoin ? 'text-argon-600/80 processing-active' : 'text-black/10'
              "
              class="ml-5 min-h-[34px] pr-3" />
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl">
            Argon will monitor the Bitcoin network to verify your multisig transaction completed.
            <TooltipArrow :width="27" :height="15" class="-mt-px ml-4 fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <div
              :class="
                lockStep === LockStep.Collecting
                  ? 'text-argon-600 border-argon-600 bg-slate-100'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative w-1/3 grow rounded-r border-y px-2 py-1 text-center text-base font-bold">
              Collect Argons
              <RoundCap class="absolute top-0 left-0" :isSelected="lockStep === LockStep.Collecting" />
              <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="lockStep === LockStep.Collecting" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="end"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-right leading-5.5 font-light text-slate-900/60 shadow-2xl">
            You will be awarded the full market value of your Bitcoin as unencumbered Argon stablecoins.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>
      </div>
    </template>

    <LockStart v-if="lockStep === LockStep.Start" @close="closeOverlay" />
    <LockIsProcessingOnArgon v-else-if="lockStep === LockStep.IsProcessingOnArgon" :personalLock="personalLock!" />
    <LockReadyForBitcoin v-else-if="lockStep === LockStep.ReadyForBitcoin" :personalLock="personalLock!" />
    <LockIsProcessingOnBitcoin v-else-if="lockStep === LockStep.ProcessingOnBitcoin" :personalLock="personalLock!" />
    <LockCollecting v-else-if="lockStep === LockStep.Collecting" :personalLock="personalLock!" @close="closeOverlay" />
  </Overlay>
</template>

<script lang="ts">
enum LockStep {
  Start = 'Start',
  IsProcessingOnArgon = 'IsProcessingOnArgon',
  ReadyForBitcoin = 'ReadyForBitcoin',
  ProcessingOnBitcoin = 'ProcessingOnBitcoin',
  Collecting = 'Collecting',
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import Overlay from './Overlay.vue';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import LockStart from './bitcoin-locking/LockStart.vue';
import LockIsProcessingOnArgon from './bitcoin-locking/LockIsProcessingOnArgon.vue';
import LockReadyForBitcoin from './bitcoin-locking/LockReadyForBitcoin.vue';
import LockIsProcessingOnBitcoin from './bitcoin-locking/LockIsProcessingOnBitcoin.vue';
import LockCollecting from './bitcoin-locking/LockCollecting.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import Arrows from '../assets/arrows.svg?component';
import RoundCap from './bitcoin-locking/components/RoundCap.vue';
import { useBitcoinLocks } from '../stores/bitcoin.ts';

dayjs.extend(utc);

const bitcoinLocks = useBitcoinLocks();

const props = defineProps<{
  personalLock?: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close', shouldFinishLocking: boolean): void;
}>();

// The tooltip is acting weird without this delay
const isLoaded = Vue.ref(false);

const personalLock = Vue.computed<IBitcoinLockRecord | undefined>(() => {
  return props.personalLock;
});

const isAtBeginning =
  !personalLock.value ||
  [BitcoinLockStatus.ReleaseComplete, BitcoinLockStatus.LockFailedToHappen].includes(personalLock.value.status);
const shouldShowFullProcess = bitcoinLocks.recordCount > 1 || isAtBeginning;

const lockStep = Vue.computed<LockStep>(() => {
  if (
    !personalLock.value ||
    [BitcoinLockStatus.ReleaseComplete, BitcoinLockStatus.LockFailedToHappen].includes(personalLock.value.status)
  ) {
    return LockStep.Start;
  } else if (personalLock.value.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
    return LockStep.IsProcessingOnArgon;
  } else if (personalLock.value.status === BitcoinLockStatus.LockReadyForBitcoin) {
    return LockStep.ReadyForBitcoin;
  } else if (personalLock.value.status === BitcoinLockStatus.LockIsProcessingOnBitcoin) {
    return LockStep.ProcessingOnBitcoin;
  } else {
    return LockStep.Collecting;
  }
});

const hasError = Vue.ref(false);

function closeOverlay() {
  emit('close', false);
}

Vue.onMounted(async () => {
  setTimeout(() => {
    isLoaded.value = true;
  }, 100);
});
</script>

<style>
@reference "../main.css";

.BitcoinLockingOverlay {
  /* Target the three arrow polygons */
  .processing-active #arrows polygon {
    opacity: 0.3;
    transition: opacity 0.2s ease-in-out;
  }

  /* Animate each arrow with a staggered delay */
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
