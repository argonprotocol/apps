<template>
  <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
    <div class="flex flex-row items-center justify-center">
      <div class="flex flex-col items-center justify-center">
        <div class="text-2xl font-bold">Error</div>
        <div class="text-sm text-gray-500">{{ transactionError }}</div>
      </div>
    </div>
  </div>

  <div v-else class="flex flex-col space-y-5 px-10 pt-10 pb-20">
    <p>
      <template v-if="isSubmittingToChain">
        Your request to lock
        {{ numeral(currency.convertSatToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }}
        BTC is being submitted to Argon.
      </template>
      <template v-else>
        Your request to lock
        {{ numeral(currency.convertSatToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }}
        BTC has been submitted to Argon and is awaiting confirmation. This usually takes a few minutes.
      </template>
    </p>

    <p class="mb-2 italic">You can close this overlay without interrupting the process.</p>

    <template v-if="isSubmittingToChain">
      <div class="fade-progress mt-10 text-center text-4xl font-bold">Submitting to chain</div>
      <div class="text-center font-light text-gray-500">Argon has not assigned a block to this request yet.</div>
    </template>

    <template v-else>
      <div class="mt-10">
        <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
      </div>

      <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />

      <div class="text-center font-light text-gray-500">
        {{ progressLabel }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from '../../../lib/numeral.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import { getCurrency } from '../../../stores/currency.ts';
import { IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';
import { generateProgressLabel } from '../../../lib/Utils.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { useBitcoinLockProgress } from '../../../stores/bitcoinLockProgress.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockProgress = useBitcoinLockProgress();
const personalLock = Vue.computed(() => props.personalLock);
const progressPct = Vue.computed(() => bitcoinLockProgress.lockProcessing.progressPct);
const transactionError = Vue.computed(() => bitcoinLockProgress.lockProcessing.error);
const isSubmittingToChain = Vue.computed(() => bitcoinLockProgress.lockProcessing.expectedConfirmations <= 0);

const progressLabel = Vue.computed(() => {
  return generateProgressLabel(
    bitcoinLockProgress.lockProcessing.confirmations,
    bitcoinLockProgress.lockProcessing.expectedConfirmations,
    { blockType: 'Argon' },
  );
});

let stopLockProgressTracking: (() => void) | undefined;

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  stopLockProgressTracking = bitcoinLockProgress.trackLock(personalLock.value);
});

Vue.watch(
  () => props.personalLock,
  nextLock => {
    bitcoinLockProgress.updateLock(nextLock);
  },
  { deep: true, immediate: true },
);

Vue.onUnmounted(() => {
  stopLockProgressTracking?.();
  stopLockProgressTracking = undefined;
});
</script>

<style scoped>
@reference "../../../main.css";

@keyframes fade-progress {
  0%,
  100% {
    color: oklch(0.48 0.24 320 / 0.3); /* text-slate-600/50 */
  }
  50% {
    color: oklch(0.48 0.24 320 / 0.7); /* argon-600 at 50% */
  }
}

.fade-progress {
  animation: fade-progress 1s ease-in-out infinite;
}
</style>
