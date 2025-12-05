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
      Your request to lock {{ numeral(currency.satsToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]') }} in
      BTC has been submitted to the Argon network and is now awaiting finalization. This process usually takes between
      four to five minutes.
    </p>

    <p class="mb-2 italic">NOTE: You can close this overlay without disrupting the process.</p>

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
import numeral from '../../lib/numeral';
import { useMyVault } from '../../stores/vaults.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { useCurrency } from '../../stores/currency.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';

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
  return generateProgressLabel(blockConfirmations.value, expectedConfirmations, { blockType: 'Argon' });
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
