<template>
  <div class="space-y-5 px-10 pt-5 pb-10">
    <p class="pt-2 font-light opacity-80">
      Your {{ numeral(currency.satsToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC unlocking request
      has been submitted to Bitcoin's network. This process usually takes an hour from start to finish.
    </p>

    <p class="font-italic mb-2 font-light opacity-80">
      NOTE: You can close this overlay without disrupting the process.
    </p>

    <div class="mt-16">
      <div class="fade-progress text-center text-5xl font-bold">{{ numeral(progressPct).format('0.00') }}%</div>
    </div>

    <ProgressBar :progress="progressPct" :showLabel="false" class="h-4" />

    <div class="text-center font-light text-gray-500">
      {{ progressLabel }}
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import numeral from '../../lib/numeral.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { useCurrency } from '../../stores/currency.ts';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import ProgressBar from '../../components/ProgressBar.vue';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const bitcoinLocks = useBitcoinLocks();
const currency = useCurrency();

const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);

let expectedConfirmations = 0;

const progressLabel = Vue.computed(() => {
  if (blockConfirmations.value === -1) {
    return 'Waiting for 1st Block...';
  } else if (blockConfirmations.value === 0 && expectedConfirmations > 0) {
    return 'Waiting for 2nd Block...';
  } else if (blockConfirmations.value === 1 && expectedConfirmations > 1) {
    return 'Waiting for 3rd Block...';
  } else if (blockConfirmations.value === 2 && expectedConfirmations > 2) {
    return 'Waiting for 4th Block...';
  } else if (blockConfirmations.value === 3 && expectedConfirmations > 3) {
    return 'Waiting for 5th Block...';
  } else if (blockConfirmations.value === 4 && expectedConfirmations > 4) {
    return 'Waiting for 6th Block...';
  } else if (blockConfirmations.value === 5 && expectedConfirmations > 5) {
    return 'Waiting for 7th Block...';
  } else if (blockConfirmations.value === 6 && expectedConfirmations > 6) {
    return 'Waiting for 8th Block...';
  } else {
    return 'Waiting for Finalization...';
  }
});

const personalLock = Vue.computed(() => {
  return props.personalLock;
});

function updateProgress() {
  const details = bitcoinLocks.getReleaseProcessingDetails(props.personalLock);
  progressPct.value = details.progressPct;
  blockConfirmations.value = details.confirmations;
  expectedConfirmations = details.expectedConfirmations;
}

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  const updateBitcoinLockProcessingInterval = setInterval(updateProgress, 1e3);
  Vue.onUnmounted(() => clearInterval(updateBitcoinLockProcessingInterval));
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
