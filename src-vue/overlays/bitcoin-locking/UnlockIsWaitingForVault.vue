<template>
  <div class="flex flex-col space-y-5 px-10 pt-5 pb-10">
    Waiting for Vault

    <div class="mt-10">
      <div class="fade-progress text-center text-5xl font-bold">{{ numeral(processingPct).format('0.00') }}%</div>
    </div>

    <ProgressBar :progress="processingPct" :showLabel="false" class="h-4" />

    <div class="mt-1 text-center font-light text-gray-500">
      {{ progressLabel }}
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import { useMyVault } from '../../stores/vaults.ts';
import numeral from '../../lib/numeral.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const myVault = useMyVault();

const processingPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);
const transactionError = Vue.ref('');

const progressLabel = Vue.computed(() => {
  if (blockConfirmations.value === -1) {
    return 'Waiting for 1st Block...';
  } else if (blockConfirmations.value === 1) {
    return 'Waiting for 2nd Block...';
  } else if (blockConfirmations.value === 2) {
    return 'Waiting for 3rd Block...';
  } else if (blockConfirmations.value === 3) {
    return 'Waiting for 4th Block...';
  } else if (blockConfirmations.value === 4) {
    return 'Waiting for 5th Block...';
  } else if (blockConfirmations.value === 5) {
    return 'Waiting for 6th Block...';
  } else {
    return 'Waiting for Finalization...';
  }
});

let isTrackingVaultCosignProgress = false;

function trackVaultCosignProgress() {
  if (isTrackingVaultCosignProgress) return;
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.VaultCosignBitcoinRelease);
  if (txInfo) {
    isTrackingVaultCosignProgress = true;
    txInfo.subscribeToProgress(
      (args: { progress: number; confirmations: number; isMaxed: boolean }, error: Error | undefined) => {
        processingPct.value = args.progress;
        blockConfirmations.value = args.confirmations;
      },
    );
  }
}

Vue.watch(
  () => props.personalLock.status,
  newStatus => {
    if (newStatus === BitcoinLockStatus.ReleaseSigned) {
      trackVaultCosignProgress();
    }
  },
);
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
