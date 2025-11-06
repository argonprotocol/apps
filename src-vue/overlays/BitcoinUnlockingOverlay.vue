<template>
  <Overlay :isOpen="true" @close="closeOverlay" @esc="closeOverlay" class="BitcoinLockingOverlay min-h-60 w-240">
    <template #title>
      <div v-if="isLoaded" class="mr-5 flex w-full flex-row items-center">
        <TooltipRoot :delayDuration="100">
          <TooltipTrigger class="flex w-[calc(33.333333%+3rem)] flex-row items-center">
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
              <div class="absolute top-0 left-0 h-full w-full overflow-hidden">
                <div
                  class="absolute top-1/2 -left-1 aspect-square h-[150%] translate-x-[-75%] -translate-y-1/2 rounded-full border border-slate-600/20 bg-white"></div>
              </div>
              <Arrow
                :class="unlockStep === UnlockStep.Start ? 'fill-slate-400/10' : 'text-slate-600/20'"
                class="absolute -top-px right-0 h-[calc(100%+2.1px)] w-5 translate-x-full" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-10"
            align="start"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left font-light text-slate-900/60 shadow-2xl">
            You must specify the address where you want your unlocked bitcoin to be sent.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <Arrows
              :class="
                unlockStep === UnlockStep.IsProcessingOnArgon ? 'text-argon-600/80 processing-active' : 'text-black/10'
              "
              class="ml-8 min-h-[34px] pr-2" />
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center font-light text-slate-900/60 shadow-2xl">
            Argon miners will validate your request and kick-off the unlocking process.
            <TooltipArrow :width="27" :height="15" class="-mt-px ml-2 fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <div
              :class="
                unlockStep === UnlockStep.IsWaitingForVault
                  ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                  : 'border-slate-600/20 bg-white text-black/20'
              "
              class="relative z-0 w-1/3 grow border-y px-2 py-1 text-center text-base font-bold">
              Wait for Cosigning
              <Arrow
                :class="unlockStep === UnlockStep.IsWaitingForVault ? '' : 'text-slate-600/20'"
                class="absolute -top-px left-0 h-[calc(100%+2.1px)] w-5 fill-white" />
              <Arrow
                :class="unlockStep === UnlockStep.IsWaitingForVault ? 'fill-slate-400/10' : 'text-slate-600/20'"
                class="absolute -top-px right-0 h-[calc(100%+2.1px)] w-5 translate-x-full" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="center"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center font-light text-slate-900/60 shadow-2xl">
            Your vault must co-sign the bitcoin multisig transaction and submit it to the network.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>

        <TooltipRoot :delayDuration="100">
          <TooltipTrigger asChild>
            <Arrows
              :class="
                unlockStep === UnlockStep.IsProcessingOnBitcoin
                  ? 'text-argon-600/80 processing-active'
                  : 'text-black/10'
              "
              class="ml-8 min-h-[34px] pr-2" />
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
              class="relative w-1/3 grow rounded-r border-y border-r px-2 py-1 text-center text-base font-bold">
              Unlock Confirmed
              <Arrow
                :class="unlockStep === UnlockStep.Complete ? '' : 'text-slate-600/20'"
                class="absolute -top-px left-0 h-[calc(100%+2.1px)] w-5 fill-white" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            :sideOffset="-7"
            align="end"
            :collisionPadding="9"
            class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-right font-light text-slate-900/60 shadow-2xl">
            Your bitcoin has now been unlocked from the Argon networkand is back in your full control.
            <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </TooltipContent>
        </TooltipRoot>
      </div>
    </template>

    <UnlockStart v-if="unlockStep === UnlockStep.Start" :personalLock="personalLock!" @close="closeOverlay" />
    <UnlockIsProcessingOnArgon
      v-else-if="unlockStep === UnlockStep.IsProcessingOnArgon"
      :personalLock="personalLock!" />
    <UnlockIsWaitingForVault v-else-if="unlockStep === UnlockStep.IsWaitingForVault" :personalLock="personalLock!" />
    <UnlockIsProcessingOnBitcoin
      v-else-if="unlockStep === UnlockStep.IsProcessingOnBitcoin"
      :personalLock="personalLock!" />
    <UnlockComplete
      v-else-if="unlockStep === UnlockStep.Complete"
      :personalLock="personalLock!"
      @close="closeOverlay" />
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import Overlay from './Overlay.vue';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import UnlockStart from './bitcoin-locking/UnlockStart.vue';
import UnlockIsProcessingOnArgon from './bitcoin-locking/UnlockIsProcessingOnArgon.vue';
import UnlockIsWaitingForVault from './bitcoin-locking/UnlockIsWaitingForVault.vue';
import UnlockIsProcessingOnBitcoin from './bitcoin-locking/UnlockIsProcessingOnBitcoin.vue';
import UnlockComplete from './bitcoin-locking/UnlockComplete.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import Arrow from './bitcoin-locking/components/Arrow.vue';
import Arrows from '../assets/arrows.svg?component';

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

enum UnlockStep {
  Start = 'Start',
  IsProcessingOnArgon = 'IsProcessingOnArgon',
  IsWaitingForVault = 'IsWaitingForVault',
  IsProcessingOnBitcoin = 'IsProcessingOnBitcoin',
  Complete = 'Complete',
}

const isMissingBitcoin = !personalLock.value || personalLock.value.status === BitcoinLockStatus.ReleaseComplete;

const unlockStep = Vue.computed<UnlockStep>(() => {
  if (isMissingBitcoin) {
    return UnlockStep.Start;
  }
  if ([BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(personalLock.value.status)) {
    return UnlockStep.Start;
  } else if (personalLock.value.status === BitcoinLockStatus.ReleaseIsProcessingOnArgon) {
    return UnlockStep.IsProcessingOnArgon;
  } else if (
    [BitcoinLockStatus.ReleaseIsWaitingForVault, BitcoinLockStatus.ReleaseSigned].includes(personalLock.value.status)
  ) {
    return UnlockStep.IsWaitingForVault;
  } else if (personalLock.value.status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) {
    return UnlockStep.IsProcessingOnBitcoin;
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
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.3);
  }
}
</style>
