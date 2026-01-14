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

    <div class="mt-1 text-center font-light text-gray-500">
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

const status = Vue.ref('');
const progressPct = Vue.ref(0);
const progressLabel = Vue.ref('Analyzing Network State...');

function trackProcessingOnArgon() {
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.BitcoinRequestRelease);
  console.log('ExtrinsicType.BitcoinRequestRelease', txInfo);

  if (txInfo) {
    txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        progressPct.value = args.progressPct * 0.33;
        progressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations, {
          blockType: 'Argon',
        });
      },
    );
  }
}

let updateBitcoinLockProcessingInterval: ReturnType<typeof setInterval> | undefined = undefined;

function updateProgressOnBitcoin() {
  const details = bitcoinLocks.getReleaseProcessingDetails(props.personalLock);
  progressPct.value = 33 + details.progressPct * 0.33;
  if (details.progressPct >= 100 && updateBitcoinLockProcessingInterval) {
    clearInterval(updateBitcoinLockProcessingInterval);
    updateBitcoinLockProcessingInterval = undefined;
  }
  if (details.releaseError) {
    progressLabel.value = `Error: ${details.releaseError}`;
    return;
  }
  progressLabel.value = generateProgressLabel(details.confirmations, details.expectedConfirmations, {
    blockType: 'Bitcoin',
  });
}

async function trackProcessingOnBitcoin() {
  await bitcoinLocks.load();
  updateBitcoinLockProcessingInterval = setInterval(updateProgressOnBitcoin, 1e3);
  updateProgressOnBitcoin();
}

let isTrackingVaultCosignProgress = false;

function trackVaultCosignProgress() {
  if (isTrackingVaultCosignProgress) return;
  const txInfo = myVault.getTxInfoByType(ExtrinsicType.VaultCosignBitcoinRelease);
  if (txInfo) {
    isTrackingVaultCosignProgress = true;
    txInfo.subscribeToProgress(
      (
        args: { progressPct: number; confirmations: number; expectedConfirmations: number },
        error: Error | undefined,
      ) => {
        progressPct.value = 66 + args.progressPct * 0.34;
        progressLabel.value = 'Waiting for Vault to Cosign';
      },
    );
  }
}

Vue.watch(
  () => personalLock.status,
  () => {
    if (status.value === personalLock.status) return;
    status.value = personalLock.status;

    if (status.value === BitcoinLockStatus.ReleaseIsProcessingOnArgon) {
      trackProcessingOnArgon();
    } else if (status.value === BitcoinLockStatus.ReleaseIsWaitingForVault) {
      trackVaultCosignProgress();
    } else if (status.value === BitcoinLockStatus.ReleaseSigned) {
      if (props.personalLock.releaseError) {
        progressLabel.value = `An unexpected error has occurred unlocking your Bitcoin: ${props.personalLock.releaseError}`;
      }
    } else if (status.value === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) {
      trackProcessingOnBitcoin();
    }
  },
  { immediate: true },
);

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
