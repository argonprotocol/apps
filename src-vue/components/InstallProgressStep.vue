<!-- prettier-ignore -->
<template>
  <li
    v-if="!['Hidden', 'Failed'].includes(stepStatus)"
    :data-status="stepStatus"
    :style="{ height: `${stepHeightPct}%`, opacity: hasError ? '0.7' : '1' }"
    class="Component InstallProgressStep max-h-24 relative flex flex-row items-center border-t border-dashed border-slate-300 text-black/30 whitespace-nowrap w-full"
  >
    <div v-if="stepStatus === 'Working'" spinner />
    <CheckboxGray
      v-else
      :isChecked="['Completed', 'Completing'].includes(stepStatus)"
      :style="{ opacity: hasError ? '0.7' : '1' }"
      color="gray"
      class="mr-2.5"
    />
    <label>{{ getLabel(stepLabel) }}</label>
    <ProgressBar
      v-if="['Working', 'Completing', 'Completed', 'Failed'].includes(stepStatus)"
      :hasError="stepStatus === 'Failed'"
      :progress="stepProgress"
    />
  </li>
  <li
    v-if="stepStatus === 'Failed'"
    :data-status="stepStatus"
    :class="{ 'opacity-50 pointer-events-none': isRetrying }"
    class="Component InstallProgressStep Failed relative flex flex-col border-t border-slate-300 text-black/70 w-full px-0 py-4 grow h-full"
  >
    <div
      class="absolute top-2 left-0 bottom-0 w-full z-0"
      style="background-image: linear-gradient(to bottom, transparent 100%, #fad1d8 90%)"
    ></div>
    <div class="flex flex-row items-center whitespace-nowrap pr-2 relative z-10 pt-4">
      <AlertIcon class="w-7 h-7 mr-2.5 text-argon-button" />
      <label class="font-bold text-lg truncate grow text-left">FAILED to {{ getLabel(stepLabel, -1) }}</label>
      <button
        v-if="!isRetrying && stepLabel.key === InstallStepKey.ServerConnect"
        @click="openServerConnectOverlay"
        class="text-argon-button font-bold px-4 py-0.5 border border-argon-button rounded cursor-pointer hover:border-argon-button-hover hover:text-argon-button-hover mr-2"
      >
        Configure Mining Machine
      </button>
      <button
        v-else-if="!isRetrying"
        @click="openServerRemoveOverlay"
        class="text-argon-button font-bold px-4 py-0.5 border border-argon-button rounded cursor-pointer hover:border-argon-button-hover hover:text-argon-button-hover mr-2"
      >
        Remove Server
      </button>
      <button
        @click="retryFailedStep(stepLabel)"
        class="text-white font-bold bg-argon-button px-4 py-0.5 border border-fuchsia-800 rounded cursor-pointer hover:bg-argon-button-hover"
      >
        <span v-if="isRetrying">Retrying...</span>
        <span v-else>Retry</span>
      </button>
    </div>
    <p
      v-if="stepLabel.key === InstallStepKey.ServerConnect"
      class="text-black/70 border-t border-dashed border-slate-400/50 pt-3 mt-3 pr-2.5 relative z-10"
    >
      Argon Investor could not connect to your server. Click the Configure Mining Machine button to modify settings. You can also retry the connection. If this issue persists, you might need to remove the current server
      and start afresh with a new one.
    </p>
    <p v-else class="text-black/70 border-t border-dashed border-slate-400/50 pt-3 pb-5 mt-3 pr-2.5 relative z-10">
      Argon Investor has encountered an unrecoverable error while trying to provision your server. Rerun this step by
      clicking Retry. If the issue persists, you might need to remove the server and start afresh with a new
      one.
    </p>
    <p class="bg-argon-600/10 font-medium text-sm text-black/70 p-5 italic my-5" v-if="errorDetails">
      <strong>Technical Error Details</strong>
      {{ errorDetails }}
    </p>
  </li>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useConfig } from '../stores/config';
import type { IStepLabel } from '../lib/InstallerStep';
import { InstallStepErrorType, InstallStepKey, InstallStepStatus } from '../interfaces/IConfig';
import ProgressBar from '../components/ProgressBar.vue';
import CheckboxGray from '../components/CheckboxGray.vue';
import AlertIcon from '../assets/alert.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import { useInstaller } from '../stores/installer';

const props = defineProps<{
  isCompact?: boolean;
  stepLabel: IStepLabel;
  stepsCount: number;
  stepIndex: number;
}>();

const config = useConfig();
const installer = useInstaller();

const stepLabel = Vue.ref<IStepLabel>(props.stepLabel);

const isRetrying = Vue.ref(false);
const hasError = Vue.computed(() => {
  return !!config.installDetails.errorType;
});

const errorDetails = Vue.computed(() => {
  const message = config.installDetails.errorMessage;
  if (!message) return null;
  return message.replace('Installation failed:', '').trim().replace('MiningMachineError:', '').trim();
});

const stepStatus = Vue.computed(() => {
  let stepStatus = config.installDetails[stepLabel.value.key].status;
  if (stepStatus === InstallStepStatus.Pending && props.stepIndex === 0) {
    stepStatus = InstallStepStatus.Working;
  }
  return stepStatus;
});

const stepProgress = Vue.computed(() => {
  if (stepStatus.value === InstallStepStatus.Completed) {
    return 100;
  } else if (stepStatus.value === InstallStepStatus.Pending) {
    return 0;
  }
  return config.installDetails[stepLabel.value.key].progress;
});

const stepHeightPct = Vue.computed(() => {
  let totalHeight = 100;
  if (config.installDetails.errorType === InstallStepErrorType.BitcoinInstall) {
    totalHeight -= 7;
  } else if (config.installDetails.errorType === InstallStepErrorType.ArgonInstall) {
    totalHeight -= 22;
  } else if (config.installDetails.errorType === InstallStepErrorType.MiningLaunch) {
    totalHeight -= 35;
  }
  return totalHeight / props.stepsCount;
});

function getLabelNumber(step: IStepLabel) {
  switch (stepStatus.value) {
    case InstallStepStatus.Pending:
      return 0;
    case InstallStepStatus.Working:
      return 1;
    case InstallStepStatus.Completing:
      return 2;
    case InstallStepStatus.Completed:
      return 2;
    case InstallStepStatus.Failed:
      return 1;
  }
  return 0;
}

function getLabel(step: IStepLabel, offset: number = 0) {
  return step.options[getLabelNumber(step) + offset];
}

async function retryFailedStep(step: IStepLabel) {
  isRetrying.value = true;
  await installer.runFailedStep(step.key);
  isRetrying.value = false;
}

function openServerRemoveOverlay() {
  basicEmitter.emit('openServerRemoveOverlay');
}

function openServerConnectOverlay() {
  basicEmitter.emit('openServerConnectOverlay');
}
</script>

<style>
@reference "../main.css";

li.Component.InstallProgressStep {
  &[isCompact='true'] {
    label {
      @apply mr-3 pl-7;
    }
    [spinner] {
      @apply h-6 min-h-6 w-6 min-w-6;
    }
  }

  @apply flex-1 py-2;

  &[data-status='Working'],
  &[data-status='Completing'] {
    label {
      @apply relative font-bold text-gray-700;
    }

    [spinner] {
      border-radius: 50%;
      display: block;
      border: 10px solid;
      border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
      animation: rotation 1s linear infinite;
    }
  }

  &[data-status='Failed'] {
    label {
      @apply text-argon-600;
    }
  }

  &[data-status='Completed'] {
    .ProgressBar {
      @apply opacity-70;
    }
  }

  label {
    @apply mr-5 font-bold;
  }

  [spinner] {
    @apply relative -left-0.5 mr-2 hidden h-8 min-h-8 w-8 min-w-8 border;
  }
}

@keyframes rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
