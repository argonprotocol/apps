<!-- prettier-ignore -->
<template>
  <div data-testid="MiningIsInstalling" class="Screen VaultIsInstalling flex flex-col items-center justify-center px-[15%] h-full w-full pb-[10%]">
    <div>
      <MiningIcon :class="errorMessage ? '' : 'pulse-animation'" class="w-36 block mb-3 mx-auto text-argon-800/80" />
      <h1 class="mt-5 text-5xl font-bold text-center text-argon-600">Initializing Your Miner</h1>

      <p v-if="errorMessage != ''" class="pt-3 font-light w-140 text-center">
        There was an error setting up your miner: <span class="text-red-700">{{ errorMessage }}</span>
      </p>

      <div class="flex flex-col w-140 pt-7">
        <ProgressBar
          :hasError="errorMessage !== ''"
          :progress="progressPct"
        />
        <div class="text-gray-500 text-center font-light mt-3">
          {{progressLabel}}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../../../stores/config.ts';
import { stepLabels, type IStepLabel } from '../../../lib/InstallerStep.ts';
import { InstallStepStatus, MiningSetupStatus } from '../../../interfaces/IConfig.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import MiningIcon from '../../../assets/mining.svg?component';
import { useWallets, getWalletKeys } from '../../../stores/wallets.ts';
import { getTransactionTracker } from '../../../stores/transactions.ts';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { MoveCapital, type ITransactionMoveMetadata } from '../../../lib/MoveCapital.ts';
import { ExtrinsicType } from '../../../lib/db/TransactionsTable.ts';
import type { TransactionInfo } from '../../../lib/TransactionInfo.ts';
import { getMyVault } from '../../../stores/vaults.ts';
import type { Config } from '../../../lib/Config.ts';

const config = getConfig();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const myVault = getMyVault();
const moveCapital = new MoveCapital(walletKeys, transactionTracker, myVault);

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
const hasEnteredTransactionPhase = Vue.computed(() => installerProgressPct.value >= 100);
const transactionProgressScaled = Vue.computed(() => 80 + txProgressPct.value * 0.2);
const targetProgressPct = Vue.computed(() =>
  hasEnteredTransactionPhase.value ? transactionProgressScaled.value : installerProgressScaled.value,
);

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

function isMiningSetupTransfer(txInfo: TransactionInfo): boolean {
  if (txInfo.tx.extrinsicType !== ExtrinsicType.Transfer) return false;

  const metadata = txInfo.tx.metadataJson as Partial<ITransactionMoveMetadata> | undefined;
  return metadata?.moveFrom === MoveFrom.MiningHold && metadata?.moveTo === MoveTo.MiningBot;
}

function findLatestSetupTransferTxInfo(): TransactionInfo | null {
  let latestTxInfo: TransactionInfo | null = null;

  for (const txInfo of transactionTracker.data.txInfos) {
    if (!isMiningSetupTransfer(txInfo)) continue;
    if (!latestTxInfo || txInfo.tx.id > latestTxInfo.tx.id) {
      latestTxInfo = txInfo;
    }
  }

  return latestTxInfo;
}

function trackTxInfo(txInfo: TransactionInfo) {
  if (trackedTxId.value === txInfo.tx.id) return;

  unsubscribeTxProgress?.();
  unsubscribeTxProgress = null;
  trackedTxId.value = txInfo.tx.id;
  transactionErrorMessage.value = '';

  txProgressLabel.value = 'Submitting capital transfer...';
  const currentStatus = txInfo.getStatus();
  txProgressPct.value = Math.max(txProgressPct.value, currentStatus.progressPct);

  unsubscribeTxProgress = txInfo.subscribeToProgress((args, error) => {
    txProgressLabel.value = `Submitted to Argon Miners: ${args.progressMessage}`;
    txProgressPct.value = Math.max(txProgressPct.value, args.progressPct);

    if (args.progressPct === 100 && error) {
      transactionErrorMessage.value = error.message;
    }

    void ensureTrackedSetupTransfer();
  });
}

async function ensureTrackedSetupTransfer(force = false) {
  const txInfo = findLatestSetupTransferTxInfo();
  if (txInfo) {
    trackTxInfo(txInfo);
  }

  if (!hasEnteredTransactionPhase.value || !wallets.isLoaded || isEnsuringSetupTransfer.value) return;

  const now = Date.now();
  if (!force && now - lastEnsureSetupTransferAt < 3_000) return;

  isEnsuringSetupTransfer.value = true;
  lastEnsureSetupTransferAt = now;

  try {
    const ensuredTxInfo = await moveCapital.moveAvailableMiningHoldToBot(
      wallets.miningHoldWallet,
      walletKeys,
      config as Config,
    );
    if (ensuredTxInfo) {
      trackTxInfo(ensuredTxInfo);
    }
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

Vue.watch(progressPct, async value => {
  if (value < 100 || errorMessage.value || isFinalizingSetup.value) return;
  if (config.miningSetupStatus === MiningSetupStatus.Finished) return;

  isFinalizingSetup.value = true;
  try {
    config.miningSetupStatus = MiningSetupStatus.Finished;
    await config.save();
  } finally {
    isFinalizingSetup.value = false;
  }
});

Vue.watch(
  () => transactionTracker.data.txInfos.length,
  () => {
    if (hasEnteredTransactionPhase.value) {
      void ensureTrackedSetupTransfer(true);
    }
  },
);

Vue.watch(hasEnteredTransactionPhase, isInTxPhase => {
  if (isInTxPhase) {
    void ensureTrackedSetupTransfer(true);
  }
});

Vue.onMounted(async () => {
  await transactionTracker.load();
  await ensureTrackedSetupTransfer(true);
});

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
