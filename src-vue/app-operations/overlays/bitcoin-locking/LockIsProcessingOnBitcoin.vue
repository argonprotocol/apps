<template>
  <div class="space-y-5 px-10 pt-5 pb-10">
    <template v-if="hasMismatch">
      <p class="pt-2 text-slate-700">
        The incoming Bitcoin amount differs from what you reserved. We can still reconcile it once Argon finalizes this
        funding candidate.
      </p>
      <div class="mt-2 rounded-md border border-slate-300/80 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span class="text-slate-600">Expected</span>
          <span class="font-mono text-slate-900">{{ reservedBtcLabel }} BTC</span>
          <span class="text-slate-400">-></span>
          <span class="text-slate-600">Received</span>
          <span class="font-mono text-slate-900">{{ observedBtcLabel }} BTC</span>
        </div>
        <div class="mt-1">
          <span class="text-slate-600">Difference</span>
          <span class="text-argon-700 ml-1 font-mono font-semibold">{{ differenceBtcLabel }}</span>
        </div>
      </div>
    </template>
    <p v-else-if="isWaitingForFirstBitcoinBlock" class="pt-2">
      <template v-if="observedBtcLabel !== undefined">
        We detected a transfer of {{ observedBtcLabel }} BTC in Bitcoin's mempool.
      </template>
      <template v-else>We detected your Bitcoin transfer in Bitcoin's mempool.</template>
      We’re waiting for the first Bitcoin block before confirmation tracking begins.
    </p>

    <p v-else class="pt-2">
      <template v-if="observedBtcLabel !== undefined">
        Argon miners confirmed a transfer of {{ observedBtcLabel }} BTC.
      </template>
      <template v-else>Argon miners confirmed your Bitcoin transfer.</template>
      We’re waiting for final confirmation on Bitcoin. This usually takes about an hour from start to finish.
    </p>

    <p class="mb-2 italic">You can close this overlay without interrupting the process.</p>

    <div
      v-if="isWaitingForFirstBitcoinBlock"
      class="mt-12 flex items-center justify-center gap-3 text-center text-gray-500">
      <Spinner class="h-5 w-5" />
      <span>Waiting for the first Bitcoin block...</span>
    </div>

    <template v-else>
      <div class="mt-16">
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
import { IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import Spinner from '../../../components/Spinner.vue';
import { generateProgressLabel } from '../../../lib/Utils.ts';
import { useBitcoinLockProgress } from '../../../stores/bitcoinLockProgress.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const bitcoinLocks = getBitcoinLocks();
const bitcoinLockProgress = useBitcoinLockProgress();
const currency = getCurrency();

const satoshisObserved = Vue.ref<bigint | undefined>(undefined);
const personalLock = Vue.computed(() => props.personalLock);
const progressPct = Vue.computed(() => bitcoinLockProgress.lockProcessing.progressPct);
const isWaitingForFirstBitcoinBlock = Vue.computed(() => bitcoinLockProgress.lockProcessing.confirmations < 0);

const progressLabel = Vue.computed(() => {
  return generateProgressLabel(
    bitcoinLockProgress.lockProcessing.confirmations,
    bitcoinLockProgress.lockProcessing.expectedConfirmations,
    { blockType: 'Bitcoin' },
  );
});

const hasMismatch = Vue.computed(() => {
  return isInvalidAmount.value && satoshisObserved.value !== undefined;
});
const isInvalidAmount = Vue.ref<boolean>(false);
const reservedBtcLabel = Vue.computed(() => {
  return numeral(currency.convertSatToBtc(personalLock.value.satoshis ?? 0n)).format('0,0.[00000000]');
});
const observedBtcLabel = Vue.computed(() => {
  if (satoshisObserved.value === undefined) return undefined;
  return numeral(currency.convertSatToBtc(satoshisObserved.value)).format('0,0.[00000000]');
});
const differenceBtcLabel = Vue.computed(() => {
  const observed = satoshisObserved.value;
  if (observed === undefined) return '0 BTC';
  const diff = observed - personalLock.value.satoshis;
  const absDiff = diff < 0n ? -diff : diff;
  const formatted = numeral(currency.convertSatToBtc(absDiff)).format('0,0.[00000000]');
  if (diff > 0n) return `+${formatted} BTC`;
  if (diff < 0n) return `-${formatted} BTC`;
  return `${formatted} BTC`;
});

function updateProgress() {
  const details = bitcoinLocks.getLockProcessingDetails(personalLock.value);
  satoshisObserved.value = details.receivedSatoshis;
  isInvalidAmount.value = details.isInvalidAmount ?? false;
}

let updateBitcoinLockProcessingInterval: ReturnType<typeof setInterval> | undefined = undefined;
let stopLockProgressTracking: (() => void) | undefined;

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  stopLockProgressTracking = bitcoinLockProgress.trackLock(personalLock.value);
  updateBitcoinLockProcessingInterval = setInterval(updateProgress, 1e3);
  updateProgress();
});

Vue.watch(
  () => props.personalLock,
  nextLock => {
    bitcoinLockProgress.updateLock(nextLock);
    updateProgress();
  },
  { deep: true, immediate: true },
);

Vue.onUnmounted(() => {
  if (updateBitcoinLockProcessingInterval) {
    clearInterval(updateBitcoinLockProcessingInterval);
  }
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
