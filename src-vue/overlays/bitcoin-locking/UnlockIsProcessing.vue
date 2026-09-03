<template>
  <div class="flex flex-col space-y-5 pt-2 pb-4">
    <p>
      Argon is processing your request to send
      {{ numeral(currency.convertSatToBtc(personalLock.fundedSatoshis)).format('0,0.[00000000]') }} BTC. This process
      requires several steps and can take between 10 and 20 minutes.
    </p>

    <p class="mb-2 italic">NOTE: You can close this overlay without disrupting the process.</p>

    <div class="mt-10">
      <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
    </div>

    <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />

    <div v-if="errorLabel" class="mt-1 text-center font-bold text-red-500">
      {{ errorLabel }}
    </div>
    <div v-else class="mt-1 text-center font-light text-gray-500">
      {{ progressLabel }}
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { useBitcoinLockProgress } from '../../stores/bitcoinLockProgress.ts';
import ProgressBar from '../../components/ProgressBar.vue';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
  cosignerLabel?: string;
}>();

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockProgress = useBitcoinLockProgress();

const personalLock = Vue.computed(() => props.personalLock);
const releaseState = Vue.computed(() => bitcoinLocks.getLockUnlockReleaseState(personalLock.value));

const progressPct = Vue.computed(() => bitcoinLockProgress.getUnlockProgressPct(personalLock.value.status));
const progressLabel = Vue.computed(() => {
  if (releaseState.value.isWaitingForVaultCosign && props.cosignerLabel) {
    return `Waiting for ${props.cosignerLabel} to sign`;
  }
  return bitcoinLockProgress.getUnlockProgressLabel(personalLock.value.status);
});
const errorLabel = Vue.computed(() => bitcoinLockProgress.getUnlockErrorLabel(personalLock.value));

Vue.watch(
  () => props.personalLock,
  nextLock => {
    bitcoinLockProgress.updateLock(nextLock);
  },
  { deep: true, immediate: true },
);

let stopProgressTracking: (() => void) | undefined;
let isDisposed = false;

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  // Persisted locks render early, so this component instance can be disposed while loading.
  if (isDisposed) return;
  stopProgressTracking = bitcoinLockProgress.trackLock(personalLock.value);
});

Vue.onUnmounted(() => {
  isDisposed = true;
  stopProgressTracking?.();
  stopProgressTracking = undefined;
});
</script>

<style scoped>
@reference "../../main.css";

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
