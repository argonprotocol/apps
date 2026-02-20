<template>
  <div class="flex flex-col space-y-5 px-10 pt-6 pb-10">
    <p>
      Argon is processing your request to unlock
      {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} in BTC. This
      process requires several steps and can take between 10 and 20 minutes.
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
import numeral from '../../lib/numeral';
import { getCurrency } from '../../stores/currency.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import { generateProgressLabel } from '../../lib/Utils.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const currency = getCurrency();
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();

const personalLock = props.personalLock;

const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('Analyzing Network State...');
const errorLabel = Vue.ref('');

let argonProcessingSubscription: (() => void) | undefined = undefined;
function trackProcessingOnArgon() {
  if (argonProcessingSubscription) return;
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.BitcoinRequestRelease);
  console.log('ExtrinsicType.BitcoinRequestRelease', txInfo);

  if (txInfo) {
    argonProcessingSubscription = txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        progressPct.value = args.progressPct * 0.33;
        progressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations, {
          blockType: 'Argon',
        });
        if (error) {
          errorLabel.value = `Error submitting to argon: ${error.message}`;
        }
      },
    );
  }
}

function updateProgressOnBitcoin() {
  const details = bitcoinLocks.getReleaseProcessingDetails(props.personalLock);
  progressPct.value = 33 + details.progressPct * 0.33;
  if (details.progressPct >= 100) {
    if (processingLoopInterval) clearInterval(processingLoopInterval);
    return;
  }
  if (details.releaseError) {
    progressLabel.value = `Error: ${details.releaseError}`;
    if (processingLoopInterval) clearInterval(processingLoopInterval);
    return;
  }
  progressLabel.value = generateProgressLabel(details.confirmations, details.expectedConfirmations, {
    blockType: 'Bitcoin',
  });
}

let cosignReleaseSubscription: (() => void) | undefined = undefined;
function trackVaultCosignProgress() {
  if (cosignReleaseSubscription) return;
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.VaultCosignBitcoinRelease);
  if (txInfo) {
    cosignReleaseSubscription = txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        progressPct.value = 66 + args.progressPct * 0.34;
        progressLabel.value = 'Waiting for Vault to Cosign';
        if (error) {
          errorLabel.value = `Error co-signing this bitcoin utxo: ${error.message}`;
        }
      },
    );
  }
}

function loadStatus() {
  const status = personalLock.status;
  if (status === BitcoinLockStatus.ReleaseIsProcessingOnArgon) {
    trackProcessingOnArgon();
  } else if (status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
    trackVaultCosignProgress();
  } else if (status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) {
    updateProgressOnBitcoin();
  }

  if (props.personalLock.releaseError) {
    errorLabel.value = `An unexpected error has occurred unlocking your Bitcoin: ${props.personalLock.releaseError}`;
  }
}

Vue.watch(
  () => personalLock.status,
  () => loadStatus(),
  { immediate: true },
);

let processingLoopInterval: ReturnType<typeof setInterval> | undefined = undefined;

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  processingLoopInterval = setInterval(() => {
    loadStatus();
  }, 5e3);
  loadStatus();
});

Vue.onUnmounted(() => {
  if (processingLoopInterval) {
    clearInterval(processingLoopInterval);
  }
  if (argonProcessingSubscription) {
    argonProcessingSubscription();
  }
  if (cosignReleaseSubscription) {
    cosignReleaseSubscription();
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
