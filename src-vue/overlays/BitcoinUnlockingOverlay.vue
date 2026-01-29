<template>
  <Overlay :isOpen="true" @close="closeOverlay" @esc="closeOverlay" class="BitcoinUnlockingOverlay min-h-60 w-240">
    <template #title>
      <div v-if="isLoaded" class="mr-6 flex w-full flex-row items-center">
        <TooltipRoot :delayDuration="100">
          <TooltipTrigger class="flex w-[calc(50%+3rem)] flex-row items-center">
            <BitcoinIcon
              :class="unlockStep === UnlockStep.Start ? 'text-argon-600/80' : 'text-black/20'"
              class="relative left-1 mr-2 h-10" />
            <div
              :class="
                unlockStep === UnlockStep.Start
                  ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative grow border-y px-2 py-1 text-center text-base font-bold">
              Initiate Unlock
              <RoundCap class="absolute top-0 left-0" :isSelected="unlockStep === UnlockStep.Start" />
              <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="unlockStep === UnlockStep.Start" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="start"
            :collisionPadding="9"
            class="text-md z-50 w-106 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left font-light text-slate-900/60 shadow-2xl">
            You must specify the address where you want your unlocked bitcoin to be sent.
            <TooltipArrow :width="27" :height="15" class="-mt-px -ml-10 fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <Arrows
              :class="unlockStep === UnlockStep.IsProcessing ? 'text-argon-600/80 processing-active' : 'text-black/10'"
              class="ml-6 min-h-[34px] pr-3" />
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center font-light text-slate-900/60 shadow-2xl">
            Bitcoin transactions require six blocks to confirm before they are considered valid.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <div
              :class="
                unlockStep === UnlockStep.Complete
                  ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative w-1/2 grow rounded-r border-y border-r px-2 py-1 text-center text-base font-bold">
              Unlock Confirmed
              <RoundCap class="absolute top-0 left-0" :isSelected="unlockStep === UnlockStep.Complete" />
              <RoundCap
                align="end"
                class="absolute top-0 right-[2px]"
                :isSelected="unlockStep === UnlockStep.Complete" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="end"
            :alignOffset="-10"
            :collisionPadding="9"
            class="text-md z-50 w-100 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left font-light text-slate-900/60 shadow-2xl">
            Your bitcoin has now been unlocked from the Argon network and is back in your full control.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>
      </div>
    </template>

    <UnlockStart v-if="unlockStep === UnlockStep.Start" :personalLock="personalLock!" @close="closeOverlay" />
    <UnlockIsProcessing v-else-if="unlockStep === UnlockStep.IsProcessing" :personalLock="personalLock!" />
    <UnlockComplete
      v-else-if="unlockStep === UnlockStep.Complete"
      :personalLock="personalLock!"
      @close="closeOverlay" />
  </Overlay>
</template>

<script lang="ts">
enum UnlockStep {
  Start = 'Start',
  IsProcessing = 'IsProcessing',
  Complete = 'Complete',
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import Overlay from './Overlay.vue';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import UnlockStart from './bitcoin-locking/UnlockStart.vue';
import UnlockIsProcessing from './bitcoin-locking/UnlockIsProcessing.vue';
import UnlockComplete from './bitcoin-locking/UnlockComplete.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import Arrows from '../assets/arrows.svg?component';
import RoundCap from './bitcoin-locking/components/RoundCap.vue';
import { getBitcoinLocks } from '../stores/bitcoin.ts';

const bitcoinLocks = getBitcoinLocks();
dayjs.extend(utc);

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

const wasOpenedWithoutBitcoin = personalLock.value?.status === BitcoinLockStatus.ReleaseComplete;

const unlockStep = Vue.computed<UnlockStep>(() => {
  if (!personalLock.value || wasOpenedWithoutBitcoin) return UnlockStep.Start;

  if (bitcoinLocks.isLockedStatus(personalLock.value)) {
    return UnlockStep.Start;
  } else if (bitcoinLocks.isReleaseStatus(personalLock.value)) {
    return UnlockStep.IsProcessing;
  } else {
    return UnlockStep.Complete;
  }
});

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

.BitcoinUnlockingOverlay {
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
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.3);
  }
}
</style>
