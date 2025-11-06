<template>
  <div v-if="transactionError" class="flex flex-col px-5 pt-6 pb-3">
    <div class="flex flex-row items-center justify-center">
      <div class="flex flex-col items-center justify-center">
        <div class="text-2xl font-bold">Error</div>
        <div class="text-sm text-gray-500">{{ transactionError }}</div>
      </div>
    </div>
  </div>

  <div v-else class="flex flex-col space-y-5 px-28 pt-10 pb-20">
    <p class="font-light text-gray-700">
      Your request to lock {{ numeral(currency.satsToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }} in
      BTC has been submitted to the Argon network and is now awaiting finalization. This process usually takes four to
      five minutes to complete.
    </p>

    <div class="mt-10">
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
import { useMyVault } from '../../stores/vaults.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import numeral from '../../lib/numeral.ts';
import { useCurrency } from '../../stores/currency.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const currency = useCurrency();
const myVault = useMyVault();

const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);
const transactionError = Vue.ref('');

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

Vue.onMounted(async () => {
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.BitcoinRequestLock);
  console.log('TX INFO', txInfo);
  if (txInfo) {
    txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        progressPct.value = args.progressPct;
        blockConfirmations.value = args.confirmations;
        expectedConfirmations = args.expectedConfirmations;
      },
    );
  }
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
