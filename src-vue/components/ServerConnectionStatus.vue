<!-- prettier-ignore -->
<template>
  <div
    v-if="isBlocking"
    class="absolute inset-0 z-20 flex h-full w-full flex-col items-center justify-center bg-slate-50 px-[15%] pb-[10%] text-center"
  >
    <div v-if="errorMessage" class="text-argon-600 mx-auto mb-3 h-16 w-16">
      <AlertIcon class="h-full w-full" />
    </div>
    <div v-else :class="isUpdating ? 'pulse-animation' : ''" class="text-argon-800/80 mx-auto mb-3 h-28 w-28">
      <slot name="icon" />
    </div>
    <h1 class="text-argon-600 mt-5 text-5xl font-bold">
      <template v-if="errorMessage">Server Update Failed</template>
      <template v-else-if="isUpdating">Updating Your Server</template>
      <template v-else>Server Unavailable</template>
    </h1>
    <div v-if="errorMessage" class="mx-auto mt-4 max-w-2xl text-lg leading-7 font-light text-slate-600">
      <p v-if="failedStepLabel" class="font-semibold text-slate-700">Failed to {{ failedStepLabel }}</p>
      <p :class="failedStepLabel ? 'mt-1' : ''">{{ errorMessage }}</p>
    </div>
    <p v-else class="mx-auto mt-4 max-w-2xl text-lg leading-7 font-light text-slate-600">
      <template v-if="isUpdating">
        {{ featureName }} will reconnect automatically when the server update finishes.
      </template>
      <template v-else>
        {{ featureName }} cannot reach your server right now. It will retry automatically.
      </template>
    </p>
    <button
      v-if="errorMessage"
      @click="retryServerUpdate"
      :disabled="isRetryingServerUpdate"
      class="border-argon-button text-argon-button hover:border-argon-button-hover hover:text-argon-button-hover mt-6 cursor-pointer rounded border px-4 py-1 font-bold disabled:pointer-events-none disabled:opacity-50"
    >
      {{ isRetryingServerUpdate ? 'Retrying...' : 'Retry' }}
    </button>
  </div>

  <div
    v-else
    class="border-argon-300/40 bg-argon-50/70 text-argon-800 mb-2 flex min-h-16 items-center rounded border px-5 py-3 shadow-sm"
  >
    <div v-if="errorMessage" class="mr-4 h-7 w-7 shrink-0">
      <AlertIcon class="h-full w-full" />
    </div>
    <div v-else :class="isUpdating ? 'pulse-animation' : ''" class="mr-4 h-10 w-10 shrink-0 opacity-70">
      <slot name="icon" />
    </div>
    <div class="min-w-0 grow">
      <div class="text-base font-bold">
        <template v-if="errorMessage">Server Update Failed</template>
        <template v-else-if="isUpdating">Server Update in Progress</template>
        <template v-else>Server Unavailable</template>
      </div>
      <div v-if="errorMessage" class="mt-0.5 text-sm font-light text-slate-600">
        <p v-if="failedStepLabel" class="font-semibold text-slate-700">Failed to {{ failedStepLabel }}</p>
        <p :class="failedStepLabel ? 'mt-0.5' : ''">{{ errorMessage }}</p>
      </div>
      <p v-else class="mt-0.5 text-sm font-light text-slate-600">
        <template v-if="isUnavailable">
          Showing the last known {{ featureName.toLowerCase() }} data. Server actions will return automatically after
          the connection recovers.
        </template>
        <template v-else>
          The server is still available but may be interrupted briefly during the update.
        </template>
      </p>
    </div>
    <button
      v-if="errorMessage"
      @click="retryServerUpdate"
      :disabled="isRetryingServerUpdate"
      class="border-argon-button text-argon-button hover:border-argon-button-hover hover:text-argon-button-hover ml-5 shrink-0 cursor-pointer rounded border px-4 py-1 font-bold disabled:pointer-events-none disabled:opacity-50"
    >
      {{ isRetryingServerUpdate ? 'Retrying...' : 'Retry' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import AlertIcon from '../assets/alert.svg?component';
import { stepLabels } from '../lib/InstallerStep.ts';
import { getConfig } from '../stores/config.ts';
import { getInstaller } from '../stores/installer.ts';

defineProps<{
  featureName: string;
  isBlocking?: boolean;
  isUnavailable?: boolean;
}>();

const config = getConfig();

const isRetryingServerUpdate = Vue.ref(false);
const errorMessage = Vue.computed(() => {
  if (!config.serverInstaller?.errorType) return;
  return config.serverInstaller.errorMessage || 'The server could not finish updating.';
});
const failedStepLabel = Vue.computed(() => {
  const errorType = config.serverInstaller?.errorType;
  return stepLabels.find(({ key }) => key.valueOf() === errorType?.valueOf())?.options[0];
});
const isUpdating = Vue.computed(() => config.isServerInstalling && !errorMessage.value);

async function retryServerUpdate() {
  if (isRetryingServerUpdate.value) return;

  isRetryingServerUpdate.value = true;
  try {
    await getInstaller().runFailedStep('all');
  } finally {
    isRetryingServerUpdate.value = false;
  }
}
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
