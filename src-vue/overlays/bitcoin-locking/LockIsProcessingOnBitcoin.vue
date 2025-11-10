<template>
  <div class="space-y-5 px-10 pt-5 pb-10">
    <div v-if="hasError" class="px-3">
      <div class="mb-10 flex w-full flex-row items-center justify-center text-red-600">
        <div class="text-red-600">
          <ExclamationTriangleIcon class="mr-2 inline-block h-10 w-10" />
          Your Bitcoin Locking Failed
        </div>
        <p class="pt-3">
          It seems you sent an incorrect amount of bitcoin. Your transaction did not match what Argon was expecting, and
          therefore could not be accepted.
        </p>
      </div>
      <button
        @click="$emit('close')"
        class="bg-argon-600/5 border-argon-600/30 text-argon-600 mb-2 w-full cursor-pointer rounded-lg border px-6 py-2 text-lg font-bold focus:outline-none">
        Close
      </button>
    </div>

    <p class="pt-2 font-light opacity-80">
      Your {{ numeral(currency.satsToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }} of BTC has been
      transferred to the correct multisig address. Argon miners are now actively monitoring Bitcoin's network for final
      confirmation. This process usually takes an hour from start to finish.
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
import numeral from 'numeral';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { useCurrency } from '../../stores/currency.ts';
import { useBitcoinLocks } from '../../stores/bitcoin.ts';
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline';
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
  console.log('expectedConfirmations', expectedConfirmations);
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

const hasError = Vue.computed(() => {
  return props.personalLock.status === BitcoinLockStatus.LockReceivedWrongAmount;
});

function updateProgress() {
  const details = bitcoinLocks.getLockProcessingDetails(props.personalLock);
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
