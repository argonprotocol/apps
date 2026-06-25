<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-[760px]">
    <template #title>
      <div class="grow text-2xl font-bold">Server Settings</div>
    </template>

    <div class="px-5 pt-4 pb-5 text-base text-slate-700">
      <p class="pb-5 font-light">
        Configure the Ethereum endpoints this server uses for gateway proofs and beacon sync.
      </p>

      <div class="grid grid-cols-[170px_1fr] gap-y-3">
        <div class="text-gray-500">Execution RPC URL</div>
        <div>
          <input
            v-model="executionRpcUrlInput"
            type="text"
            :placeholder="getDefaultEthereumExecutionRpcUrl() || 'https://rpc.example'"
            class="focus:border-argon-500 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm font-medium text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
          <div class="pt-1 text-xs font-light text-slate-500">
            Leave blank to use the network default shown in the placeholder for this machine.
          </div>
        </div>

        <div class="text-gray-500">Beacon API URL</div>
        <div>
          <input
            v-model="beaconApiUrlInput"
            type="text"
            :placeholder="getDefaultEthereumBeaconApiUrl() || 'https://beacon.example'"
            class="focus:border-argon-500 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm font-medium text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
          <div class="pt-1 text-xs font-light text-slate-500">
            Leave blank to use the network default shown in the placeholder. Use Disable Sync if you want this machine
            to stop beacon syncing.
          </div>
        </div>

        <div class="text-gray-500">Beacon Sync Mode</div>
        <div>
          <div class="font-mono font-semibold">
            <template v-if="config.ethereumBeaconApiUrl === ''">Disabled on this machine</template>
            <template v-else-if="config.ethereumBeaconApiUrl?.trim()">Using custom beacon API</template>
            <template v-else>Using network default beacon API</template>
          </div>
          <div class="pt-1 text-xs font-light text-slate-500">
            {{ formatEthereumSyncStatus(ethereumSyncState?.mode, ethereumSyncState?.lastError) }}
          </div>
          <div v-if="ethereumSyncState?.mode === 'submitting'" class="pt-1 text-xs font-medium text-amber-700">
            Execution anchor and sync period values are the latest observed snapshot while the verifier transaction is
            still being checked.
          </div>
          <div v-if="ethereumSyncLastUpdatedAt" class="pt-1 text-xs font-light text-slate-500">
            Status updated
            <CountupClock as="span" :time="ethereumSyncLastUpdatedAt" v-slot="{ hours, minutes, seconds, isNull }">
              <template v-if="hours">{{ hours }}h,</template>
              <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
              <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
              <template v-else-if="isNull">-- ----</template>
            </CountupClock>
          </div>
          <div v-if="settingsActionError" class="pt-2 text-sm font-medium text-red-600">
            {{ settingsActionError }}
          </div>
          <div v-else-if="settingsActionMessage" class="pt-2 text-sm font-medium text-emerald-700">
            {{ settingsActionMessage }}
          </div>
        </div>
      </div>

      <div class="mt-6 flex flex-wrap gap-2 border-t border-dashed border-slate-300 pt-4">
        <button
          @click="saveServerSettings()"
          :disabled="isSavingSettings"
          class="border-argon-600/50 text-argon-700 rounded border px-3 py-1 text-center disabled:cursor-not-allowed disabled:opacity-50"
        >
          <template v-if="isSavingSettings">Saving…</template>
          <template v-else>Apply Server Settings</template>
        </button>
        <button
          @click="saveServerSettings({ disableBeaconSync: true })"
          :disabled="isSavingSettings || config.ethereumBeaconApiUrl === ''"
          class="rounded border border-slate-300 px-3 py-1 text-center text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Disable Beacon Sync
        </button>
        <button @click="closeOverlay" class="rounded border border-slate-300 px-3 py-1 text-center text-slate-700">
          Close
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import CountupClock from '../../components/CountupClock.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import {
  getDefaultEthereumBeaconApiUrl,
  getDefaultEthereumExecutionRpcUrl,
  getEthereumBeaconApiUrl,
  getEthereumExecutionRpcUrl,
} from '../../lib/EthereumClient.ts';
import { getBot } from '../../stores/bot.ts';
import { getConfig } from '../../stores/config.ts';
import { getInstaller } from '../../stores/installer.ts';

const bot = getBot();
const config = getConfig();
const installer = getInstaller();

const isOpen = Vue.ref(false);
const beaconApiUrlInput = Vue.ref('');
const executionRpcUrlInput = Vue.ref('');
const isSavingSettings = Vue.ref(false);
const settingsActionError = Vue.ref('');
const settingsActionMessage = Vue.ref('');

const ethereumSyncState = Vue.computed(() => {
  return bot.state?.ethereumSync;
});

const ethereumSyncLastUpdatedAt = Vue.computed(() => {
  const lastUpdatedAt = ethereumSyncState.value?.lastUpdatedAt;
  return lastUpdatedAt ? dayjs(lastUpdatedAt) : null;
});

basicEmitter.on('openServerSettingsOverlay', async () => {
  isOpen.value = true;
  await refreshServerSettings();
  await bot.refreshState().catch(() => undefined);
});

Vue.onMounted(async () => {
  if (!config.isLoaded) {
    await config.load();
  }

  await refreshServerSettings();
});

function closeOverlay() {
  isOpen.value = false;
}

async function saveServerSettings(args: { disableBeaconSync?: boolean } = {}) {
  settingsActionError.value = '';
  settingsActionMessage.value = '';
  isSavingSettings.value = true;

  const nextExecutionRpcUrl = executionRpcUrlInput.value.trim();
  const nextBeaconApiUrl = beaconApiUrlInput.value.trim();
  const savedExecutionRpcUrl = nextExecutionRpcUrl || undefined;
  const savedBeaconApiUrl = args.disableBeaconSync ? '' : nextBeaconApiUrl || undefined;

  try {
    validateOptionalUrl('Execution RPC URL', savedExecutionRpcUrl);
    validateOptionalUrl('Beacon API URL', args.disableBeaconSync ? undefined : savedBeaconApiUrl);

    if (!args.disableBeaconSync && !getEthereumBeaconApiUrl(savedBeaconApiUrl)) {
      throw new Error('A beacon API URL is required to activate syncing.');
    }

    const previousBeaconApiUrl = config.ethereumBeaconApiUrl;
    const previousExecutionRpcUrl = config.ethereumExecutionRpcUrl;
    const shouldBeEnabled = !!getEthereumBeaconApiUrl(savedBeaconApiUrl);

    try {
      config.ethereumExecutionRpcUrl = savedExecutionRpcUrl;
      config.ethereumBeaconApiUrl = savedBeaconApiUrl;
      await config.save();
      await installer.updateServerConfig();
      await refreshServerSettings();
      await waitForBeaconSyncState(shouldBeEnabled);
      settingsActionMessage.value = args.disableBeaconSync
        ? 'Server settings applied. Beacon sync disabled.'
        : 'Server settings applied.';
    } catch (error) {
      config.ethereumExecutionRpcUrl = previousExecutionRpcUrl;
      config.ethereumBeaconApiUrl = previousBeaconApiUrl;
      await config.save().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    settingsActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSavingSettings.value = false;
  }
}

async function refreshServerSettings() {
  settingsActionError.value = '';
  settingsActionMessage.value = '';
  executionRpcUrlInput.value = config.ethereumExecutionRpcUrl?.trim() ?? '';
  beaconApiUrlInput.value =
    config.ethereumBeaconApiUrl && config.ethereumBeaconApiUrl !== '' ? config.ethereumBeaconApiUrl : '';
}

async function waitForBeaconSyncState(shouldBeEnabled: boolean) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    await bot.refreshState().catch(() => undefined);
    const mode = bot.state?.ethereumSync?.mode;

    if (shouldBeEnabled) {
      if (mode && mode !== 'disabled') {
        return;
      }
    } else if (!mode || mode === 'disabled') {
      return;
    }

    await new Promise(resolve => window.setTimeout(resolve, 1_000));
  }
}

function validateOptionalUrl(label: string, value?: string) {
  if (!value) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
}

function formatEthereumSyncStatus(mode?: string, lastError?: string) {
  switch (mode) {
    case 'needsBootstrap':
      return 'Waiting for one-time sudo bootstrap';
    case 'idle':
      return 'Idle and ready to sync';
    case 'submitting':
      return 'Submitting verifier maintenance transactions';
    case 'error':
      return lastError ? `Sync error: ${lastError}` : 'Sync error';
    case 'disabled':
      return 'Disabled';
    default:
      return getEthereumBeaconApiUrl(config.ethereumBeaconApiUrl) ? 'Configured' : 'Disabled';
  }
}
</script>
