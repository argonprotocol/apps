<template>
  <div class="space-y-5 px-10 pt-5 pb-10">
    <div v-if="hasError" class="px-3">
      <div class="mb-10 flex w-full flex-row">
        <ExclamationTriangleIcon class="mr-5 h-16 w-16 text-red-600" />
        <div class="flex flex-col">
          <h1 class="text-2xl font-bold text-red-600">Your Bitcoin Locking Failed</h1>
          <p>
            The amount of bitcoin you sent ({{
              numeral(currency.convertSatToBtc(satoshisObserved ?? 0n)).format('0,0.[00000000]')
            }}
            BTC) was too far outside the requested lock amount ({{
              numeral(currency.convertSatToBtc(personalLock.satoshis ?? 0n)).format('0,0.[00000000]')
            }}
            BTC). Your transaction could not be accepted. Please reach out on
            <a class="!text-argon-600 hover:text-argon-800 cursor-pointer font-bold" @click="openDiscord">Discord</a>
            so we can help you coordinate unlocking the orphaned UTXO.
          </p>
        </div>
      </div>
    </div>

    <template v-else>
      <p class="pt-2">
        Argon miners have confirmed a transfer of
        {{ numeral(currency.convertSatToBtc(satoshisObserved ?? 0n)).format('0,0.[00000000]') }} BTC is being received.
        We are monitoring Bitcoin's network for final confirmation. This process usually takes an hour from start to
        finish.
      </p>

      <p class="mb-2 italic">NOTE: You can close this overlay without disrupting the process.</p>

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
import numeral from '../../lib/numeral';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline';
import ProgressBar from '../../components/ProgressBar.vue';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();

const satoshisObserved = Vue.ref<bigint | undefined>(undefined);
const progressPct = Vue.ref(0);
const blockConfirmations = Vue.ref(-1);

let expectedConfirmations = 0;

const progressLabel = Vue.computed(() => {
  return generateProgressLabel(blockConfirmations.value, expectedConfirmations, { blockType: 'Bitcoin' });
});

const personalLock = Vue.computed(() => {
  return props.personalLock;
});

function openDiscord() {
  void tauriOpenUrl('https://discord.gg/xDwwDgCYr9');
}
const hasError = Vue.ref<boolean>(false);

function updateProgress() {
  const details = bitcoinLocks.getLockProcessingDetails(props.personalLock);
  progressPct.value = details.progressPct;
  blockConfirmations.value = details.confirmations;
  expectedConfirmations = details.expectedConfirmations;
  satoshisObserved.value = details.receivedSatoshis;
  hasError.value = details.isInvalidAmount ?? false;
}

let updateBitcoinLockProcessingInterval: ReturnType<typeof setInterval> | undefined = undefined;

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  updateBitcoinLockProcessingInterval = setInterval(updateProgress, 1e3);
  updateProgress();
});

Vue.onUnmounted(() => {
  if (updateBitcoinLockProcessingInterval) {
    clearInterval(updateBitcoinLockProcessingInterval);
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
