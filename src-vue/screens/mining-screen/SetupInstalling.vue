<!-- prettier-ignore -->
<template>
  <div DashBox data-testid="MiningIsInstalling" class="Screen VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <MiningIcon :class="errorMessage ? '' : 'pulse-animation'" class="mx-auto mb-3 block h-28 text-argon-800/80" />
      <h1 class="mt-5 text-5xl font-bold text-center text-argon-600">Initializing Your Miner</h1>

      <p
        v-if="errorMessage != ''"
        data-testid="MiningIsInstalling.errorMessage"
        class="mx-auto w-140 pt-3 text-center font-light"
      >
        There was an error setting up your miner: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <div class="mx-auto flex w-140 flex-col pt-7">
        <ProgressBar
          :hasError="errorMessage !== ''"
          :progress="progressPct"
        />
        <div class="text-gray-500 text-center font-light mt-3">
          {{progressLabel}}
        </div>
        <button
          v-if="transactionErrorMessage"
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover mx-auto mt-5 cursor-pointer rounded-md px-5 py-2 font-bold text-white disabled:cursor-wait disabled:opacity-60"
          :disabled="isEnsuringSetupTransfer"
          @click="ensureMiningSetup(true)"
        >
          {{ isEnsuringSetupTransfer ? 'Retrying Mining Setup...' : 'Retry Mining Setup' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../../stores/config.ts';
import { stepLabels, type IStepLabel } from '../../lib/InstallerStep.ts';
import { InstallStepStatus, MiningSetupStatus } from '../../interfaces/IConfig.ts';
import ProgressBar from '../../components/ProgressBar.vue';
import MiningIcon from '../../assets/mining.svg?component';
import { getMiningSetup, useWallets } from '../../stores/wallets.ts';
import type { TransactionInfo } from '../../lib/TransactionInfo.ts';
import type { Config } from '../../lib/Config.ts';
import { getMiningFundingState } from './miningFunding.ts';

const config = getConfig();
const wallets = useWallets();
const miningSetup = getMiningSetup();

const transactionErrorMessage = Vue.ref('');
const progressPct = Vue.ref(0);
const txProgressPct = Vue.ref(0);
const txProgressLabel = Vue.ref('Preparing capital transfer...');
const trackedTxId = Vue.ref<number | null>(null);
const isEnsuringSetupTransfer = Vue.ref(false);

const installerErrorMessage = Vue.computed(() => config.serverInstaller.errorMessage ?? '');
const errorMessage = Vue.computed(() => transactionErrorMessage.value || installerErrorMessage.value);

const installerProgressPct = Vue.computed(() => {
  let totalProgress = 0;
  for (const [index, stepLabel] of stepLabels.entries()) {
    const stepStatus = getStepStatus(stepLabel, index);
    if (stepStatus === InstallStepStatus.Completed) {
      totalProgress += 100;
    } else if (stepStatus === InstallStepStatus.Pending) {
      totalProgress += 0;
    } else {
      totalProgress += config.serverInstaller[stepLabel.key].progress;
    }
  }
  return stepLabels.length ? totalProgress / stepLabels.length : 0;
});

const installerProgressScaled = Vue.computed(() => installerProgressPct.value * 0.8);
const hasEnteredTransactionPhase = Vue.computed(() => {
  return installerProgressPct.value >= 100 || (config.isServerInstalled && !config.isServerInstalling);
});
const transactionProgressScaled = Vue.computed(() => 80 + txProgressPct.value * 0.2);
const targetProgressPct = Vue.computed(() =>
  hasEnteredTransactionPhase.value ? transactionProgressScaled.value : installerProgressScaled.value,
);
const miningMicronotsOnHand = Vue.computed(() => {
  return (
    wallets.defaultArgonWallet.availableMicronots +
    wallets.defaultArgonWallet.reservedMicronots +
    wallets.miningBotWallet.availableMicronots +
    wallets.miningBotWallet.reservedMicronots
  );
});
const fundingState = Vue.computed(() => {
  return getMiningFundingState({
    hasSavedBiddingRules: config.hasSavedBiddingRules,
    miningSetupStatus: config.miningSetupStatus,
    miningMicrogonsOnHand: wallets.totalMiningMicrogons,
    miningMicronotsOnHand: miningMicronotsOnHand.value,
    initialMicrogonRequirement: config.biddingRules.initialMicrogonRequirement,
    initialMicronotRequirement: config.biddingRules.initialMicronotRequirement,
  });
});

const progressLabel = Vue.computed(() => {
  if (hasEnteredTransactionPhase.value) {
    return txProgressLabel.value;
  }

  let activeStep: IStepLabel | undefined;
  let activeStepStatus = InstallStepStatus.Pending;

  for (const [index, stepLabel] of stepLabels.entries()) {
    const stepStatus = getStepStatus(stepLabel, index);
    if (stepStatus !== InstallStepStatus.Completed) {
      activeStep = stepLabel;
      activeStepStatus = stepStatus;
      break;
    }
  }

  if (!activeStep) {
    return stepLabels.length
      ? getStepLabel(stepLabels[stepLabels.length - 1], InstallStepStatus.Completed)
      : 'Installing server...';
  }

  return getStepLabel(activeStep, activeStepStatus);
});

let unsubscribeTxProgress: (() => void) | null = null;
const isFinalizingSetup = Vue.ref(false);
let lastEnsureSetupTransferAt = 0;

function getStepStatus(stepLabel: IStepLabel, index: number): InstallStepStatus {
  let stepStatus = config.serverInstaller[stepLabel.key].status;
  if (stepStatus === InstallStepStatus.Pending && index === 0) {
    stepStatus = InstallStepStatus.Working;
  }
  return stepStatus;
}

function getStepLabel(stepLabel: IStepLabel, stepStatus: InstallStepStatus): string {
  const optionIndexByStatus: Record<InstallStepStatus, number> = {
    [InstallStepStatus.Pending]: 0,
    [InstallStepStatus.Working]: 1,
    [InstallStepStatus.Completing]: 2,
    [InstallStepStatus.Completed]: 2,
    [InstallStepStatus.Failed]: 1,
    [InstallStepStatus.Hidden]: 0,
  };
  return stepLabel.options[optionIndexByStatus[stepStatus]];
}

function trackTxInfo(txInfo: TransactionInfo) {
  if (trackedTxId.value === txInfo.tx.id) return;

  unsubscribeTxProgress?.();
  unsubscribeTxProgress = null;
  trackedTxId.value = txInfo.tx.id;
  transactionErrorMessage.value = '';

  txProgressLabel.value = 'Preparing mining account...';
  const currentStatus = txInfo.getStatus();
  txProgressPct.value = currentStatus.progressPct;

  unsubscribeTxProgress = txInfo.subscribeToProgress((args, error) => {
    txProgressLabel.value = `Submitted to Argon Miners: ${args.progressMessage}`;
    txProgressPct.value = args.progressPct;

    if (args.progressPct === 100 && error) {
      transactionErrorMessage.value = error.message;
    }
  });
}

function trackSetupTransaction(
  setupResult: Extract<Awaited<ReturnType<typeof miningSetup.ensure>>, { kind: 'transaction' }>,
) {
  trackTxInfo(setupResult.txInfo);

  void setupResult.waitForCompletion
    .then(async () => {
      if (fundingState.value.isFullyFunded) {
        txProgressLabel.value = 'Mining capital is ready.';
        txProgressPct.value = 100;
        await finalizeMiningSetup();
        return;
      }

      trackedTxId.value = null;
      await ensureMiningSetup(true);
    })
    .catch(error => {
      transactionErrorMessage.value =
        error instanceof Error ? error.message : 'Unknown error occurred while preparing mining capital.';
    });
}

async function finalizeMiningSetup() {
  if (errorMessage.value || isFinalizingSetup.value) return;
  if (config.miningSetupStatus === MiningSetupStatus.Finished) return;

  isFinalizingSetup.value = true;
  progressPct.value = 100;

  try {
    config.miningSetupStatus = MiningSetupStatus.Finished;
    await config.save();
  } finally {
    isFinalizingSetup.value = false;
  }
}

async function ensureMiningSetup(force = false) {
  if (!hasEnteredTransactionPhase.value) return;

  if (!wallets.isLoaded || isEnsuringSetupTransfer.value) return;

  const now = Date.now();
  if (!force && now - lastEnsureSetupTransferAt < 3_000) return;

  isEnsuringSetupTransfer.value = true;
  lastEnsureSetupTransferAt = now;

  try {
    const setupResult = await miningSetup.ensure({
      defaultWallet: wallets.defaultArgonWallet,
      miningBotWallet: wallets.miningBotWallet,
      config: config as Config,
    });
    if (setupResult.kind === 'transaction') {
      trackSetupTransaction(setupResult);
      return;
    }
    if (setupResult.kind === 'ready') {
      transactionErrorMessage.value = '';
      txProgressLabel.value = 'Mining capital is ready.';
      txProgressPct.value = 100;
      await finalizeMiningSetup();
      return;
    }
    if (setupResult.kind === 'noSpendableFundsToSweep') {
      if (fundingState.value.isFullyFunded) {
        transactionErrorMessage.value = '';
        txProgressLabel.value = 'Mining capital is ready.';
        txProgressPct.value = 100;
        await finalizeMiningSetup();
        return;
      }

      txProgressPct.value = 0;
      txProgressLabel.value = 'Mining capital needs attention.';
      transactionErrorMessage.value = 'This miner is not fully funded yet.';
      return;
    }

    txProgressPct.value = 0;
    txProgressLabel.value = 'Mining capital needs attention.';
    transactionErrorMessage.value = setupResult.error;
  } catch (error) {
    console.error('[Mining Setup] Unable to prepare the mining account', error);
    txProgressPct.value = 0;
    txProgressLabel.value = 'Mining capital needs attention.';
    transactionErrorMessage.value =
      error instanceof Error ? error.message : 'Unknown error occurred while preparing mining capital.';
  } finally {
    isEnsuringSetupTransfer.value = false;
  }
}

Vue.watch(
  targetProgressPct,
  value => {
    progressPct.value = Math.max(progressPct.value, Math.min(100, value));
  },
  { immediate: true },
);

Vue.watch(hasEnteredTransactionPhase, isInTxPhase => {
  if (isInTxPhase) {
    void ensureMiningSetup(true);
  }
});

Vue.watch(
  () => wallets.isLoaded,
  isLoaded => {
    if (isLoaded) void ensureMiningSetup(true);
  },
);

Vue.onMounted(() => void ensureMiningSetup(true));

Vue.onUnmounted(() => {
  unsubscribeTxProgress?.();
  unsubscribeTxProgress = null;
});
</script>

<style scoped>
.pulse-animation {
  animation: pulse 1.5s ease-in-out infinite;
  transform-origin: center bottom;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}
</style>
