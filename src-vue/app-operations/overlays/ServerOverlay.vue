<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @pressEsc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="text-2xl font-bold grow">{{ overlayTitle }}</div>
    </template>
    <div class="px-6 py-4 text-base font-medium text-gray-700">
      <div v-if="overlayMode === 'loading'" class="text-center">
        Loading
      </div>
      <div v-else-if="overlayMode === 'installing'">
        <p v-if="config.isServerInstalled" class="pt-2 pb-5 font-light">
          We are updating the bot program on your {{ serverIdentity() }}. This will only
          take a few minutes to complete. Please do not close this app until it is finished.
        </p>
        <p v-else class="pt-1 pb-6 font-light leading-6">
          We are verifying and setting up your {{ serverIdentity() }}. This may take several
          hours to complete. You can close this overlay and app without affecting the installation process.
        </p>
        <div class="border-t border-dashed border-slate-300 text-black/40">
          <InstallProgress />
        </div>
        <div class="border-t border-dashed border-slate-300">
          <button @click="closeOverlay" class="text-argon-700 border border-argon-600/50 rounded w-full py-2 mt-5 text-center cursor-pointer">
            Close Overlay
          </button>
        </div>
      </div>

      <div v-else-if="overlayMode === 'error'">
        <p class="pt-3 pb-3 font-light">
          There was an error setting up your {{ serverType() }} server. See below for details.
        </p>
        <div class="border-t border-dashed border-slate-300 text-black/40">
          <InstallProgress />
        </div>
      </div>

      <div v-else>
        <p class="pt-2 pb-4 font-light" v-if="overlayMode === 'installComplete'">
          Installation is complete. Your {{ serverIdentity() }} is online.
        </p>
        <p class="pt-2 pb-4 font-light" v-else>
          Server details and latest node activity.
        </p>

        <div class="grid grid-cols-[170px_1fr] gap-y-2 text-base">
          <div class="h-px col-span-full bg-slate-400/30 my-2" />

          <div class="text-gray-500">IP Address</div>
          <div class="font-semibold font-mono">{{ serverDetails.ipAddress || '--' }}</div>

          <div class="text-gray-500">SSH Username</div>
          <div class="font-semibold font-mono">{{ serverDetails.sshUser || '--' }}</div>

          <div class="h-px col-span-full bg-slate-400/30 my-2" />

          <div class="text-gray-500">Last Bitcoin Block</div>
          <div class="font-semibold font-mono">
            #{{ formatBlock(stats.serverState.bitcoinLocalNodeBlockNumber) }}
            <span class="font-light">
              mined
              <CountupClock as="span" :time="lastBitcoinActivityAt" v-slot="{ hours, minutes, seconds, isNull }">
                <template v-if="hours">{{ hours }}h, </template>
                <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                <template v-else-if="isNull">-- ----</template>
              </CountupClock>
              (<BitcoinBlocksOverlay>
                <span class="cursor-pointer text-argon-600/50 hover:text-argon-600">view blocks</span>
              </BitcoinBlocksOverlay>)
            </span>
          </div>

          <div class="text-gray-500">Last Argon Block</div>
          <div class="font-semibold font-mono">
            #{{ formatBlock(stats.serverState.argonLocalNodeBlockNumber) }}
            <span class="font-light">
              mined
              <CountupClock as="span" :time="lastArgonActivityAt" v-slot="{ hours, minutes, seconds, isNull }">
                <template v-if="hours">{{ hours }}h, </template>
                <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                <template v-else-if="isNull">-- ----</template>
              </CountupClock>
              (<ArgonBlocksOverlay>
                <span class="cursor-pointer text-argon-600/50 hover:text-argon-600">view blocks</span>
              </ArgonBlocksOverlay>)
            </span>
          </div>

          <div class="text-gray-500">Last Bidder Activity</div>
          <div class="font-light font-mono">
            <CountupClock as="span" :time="botActivityLastUpdatedAt" v-slot="{ hours, minutes, seconds, isNull }">
              <template v-if="hours">{{ hours }}h, </template>
              <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
              <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
              <template v-else-if="isNull">-- ----</template>
            </CountupClock>
            <span class="whitespace-nowrap">
              (<ActiveBidsOverlayButton class="ml-1.5 inline-block">
                <span class="cursor-pointer text-argon-600/50 hover:text-argon-600">view list</span>
              </ActiveBidsOverlayButton>
                <span class="opacity-50 px-1">/</span>
              <BotHistoryOverlayButton class="inline-block">
                <span class="cursor-pointer text-argon-600/50 hover:text-argon-600">view activity</span>
              </BotHistoryOverlayButton>)
            </span>
          </div>

          <div class="h-px col-span-full bg-slate-400/30 my-2" />

          <div class="text-gray-500">Treasury Members</div>
          <div class="font-light font-mono">0 (
            view members
            <span class="opacity-50 px-2">/</span>
            view pending invites
          )</div>

          <div class="text-gray-500">Operational Members</div>
          <div class="font-light font-mono">0 (
            view members
            <span class="opacity-50 px-2">/</span>
            view pending invites
          )</div>

          <div class="h-px col-span-full bg-slate-400/30 my-2" />

          <div class="col-span-full pt-1 text-sm font-semibold uppercase tracking-wide text-gray-600">
            Ethereum Beacon Sync
          </div>

          <div class="text-gray-500">Beacon API URL</div>
          <div>
            <input
              v-model="beaconApiUrlInput"
              type="text"
              :placeholder="defaultBeaconApiUrl || 'https://beacon.example'"
              class="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm font-medium text-slate-700 focus:border-argon-500 focus:outline-none"
            />
            <div class="pt-1 text-xs font-light text-slate-500">
              Uses the network default unless you override or disable it here.
            </div>
          </div>

          <div class="text-gray-500">Sync Status</div>
          <div>
            <div class="font-semibold font-mono">
              {{ beaconSyncStatusLabel }}
            </div>
            <div v-if="ethereumSyncState?.lastSubmittedTxHash" class="pt-1 text-xs font-light text-slate-500 break-all">
              Last tx: {{ ethereumSyncState.lastSubmittedTxHash }}
            </div>
            <div v-if="ethereumSyncState?.latestFinalizedSlot !== undefined" class="pt-1 text-xs font-light text-slate-500">
              Finalized slot: {{ ethereumSyncState.latestFinalizedSlot.toString() }}
            </div>
            <div
              v-if="ethereumSyncState?.latestSyncCommitteeUpdatePeriod !== undefined"
              class="pt-1 text-xs font-light text-slate-500"
            >
              Sync period: {{ ethereumSyncState.latestSyncCommitteeUpdatePeriod.toString() }}
            </div>
            <div v-if="beaconSyncActionError" class="pt-2 text-sm font-medium text-red-600">
              {{ beaconSyncActionError }}
            </div>
            <div v-else-if="beaconSyncActionMessage" class="pt-2 text-sm font-medium text-emerald-700">
              {{ beaconSyncActionMessage }}
            </div>
          </div>

          <div class="col-span-full flex flex-wrap gap-2 pt-1">
            <button
              @click="setBeaconSync({ nextBeaconApiUrl: beaconApiUrlInput })"
              :disabled="isBeaconSyncSaveDisabled"
              class="rounded border border-argon-600/50 px-3 py-1 text-center text-argon-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {{ beaconSyncSaveLabel }}
            </button>
            <button
              @click="setBeaconSync({ disable: true })"
              :disabled="isBeaconSyncSaving || !effectiveBeaconApiUrl"
              class="rounded border border-slate-300 px-3 py-1 text-center text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Disable Sync
            </button>
          </div>
        </div>

        <div class="border-t border-dashed border-slate-300 pt-4 mt-4 flex items-center gap-2">
          <button @click="openTroubleshooting" class="text-argon-700 border rounded px-3 py-1 text-center cursor-pointer">
            Troubleshooting
          </button>
          <button @click="closeOverlay" class="text-argon-700 border rounded px-3 py-1 text-center cursor-pointer">
            Close
          </button>
        </div>
      </div>

    </div>
  </OverlayBase>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ServerType } from '../../interfaces/IConfig.ts';
import { getConfig } from '../../stores/config.ts';
import InstallProgress from '../../components/InstallProgress.vue';
import { getInstaller } from '../../stores/installer.ts';
import { getStats } from '../../stores/stats.ts';
import { getBot } from '../../stores/bot.ts';
import { getEthereumBeaconApiUrl } from '../../lib/EthereumClient.ts';
import ArgonBlocksOverlay from './ArgonBlocksOverlay.vue';
import BitcoinBlocksOverlay from './BitcoinBlocksOverlay.vue';
import CountupClock from '../../components/CountupClock.vue';
import ActiveBidsOverlayButton from './ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from './BotHistoryOverlayButton.vue';

dayjs.extend(utc);

const config = getConfig();
const installer = getInstaller();
const stats = getStats();
const bot = getBot();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const showInstallComplete = Vue.ref(false);
const beaconApiUrlInput = Vue.ref('');
const isBeaconSyncSaving = Vue.ref(false);
const beaconSyncActionError = Vue.ref('');
const beaconSyncActionMessage = Vue.ref('');

const defaultBeaconApiUrl = Vue.computed(() => {
  return getEthereumBeaconApiUrl() ?? '';
});

const effectiveBeaconApiUrl = Vue.computed(() => {
  if (config.ethereumBeaconApiUrl === '') {
    return '';
  }

  return getEthereumBeaconApiUrl(config.ethereumBeaconApiUrl) ?? '';
});

const ethereumSyncState = Vue.computed(() => {
  return bot.state?.ethereumSync;
});

const beaconSyncStatusLabel = Vue.computed(() => {
  return formatBeaconSyncStatus(ethereumSyncState.value?.mode, ethereumSyncState.value?.lastError);
});

const isBeaconSyncSaveDisabled = Vue.computed(() => {
  return isBeaconSyncSaving.value || (!beaconApiUrlInput.value.trim() && !defaultBeaconApiUrl.value);
});

const beaconSyncSaveLabel = Vue.computed(() => {
  if (isBeaconSyncSaving.value) {
    return 'Saving…';
  }
  if (effectiveBeaconApiUrl.value) {
    return 'Apply Sync Settings';
  }
  if (defaultBeaconApiUrl.value) {
    return 'Use Network Default';
  }
  return 'Activate Sync';
});

const serverDetails = Vue.computed(() => {
  return isLoaded.value ? config.serverDetails : ({} as any);
});

const hasError = Vue.computed(() => {
  return isLoaded.value ? !!config.serverInstaller.errorType : false;
});

const isInstalling = Vue.computed(() => {
  if (!isLoaded.value) return false;
  return installer.isRunning || config.isServerInstalling || !config.isServerInstalled;
});

const overlayMode = Vue.computed<'loading' | 'installing' | 'installComplete' | 'details' | 'error'>(() => {
  if (!isLoaded.value) return 'loading';
  if (hasError.value) return 'error';
  if (showInstallComplete.value) return 'installComplete';
  if (isInstalling.value) return 'installing';
  return 'details';
});

const lastBitcoinActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.bitcoinBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const lastArgonActivityAt = Vue.computed(() => {
  const lastActivity = stats.serverState.argonBlocksLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const botActivityLastUpdatedAt = Vue.computed(() => {
  const lastActivity = stats.serverState.botActivityLastUpdatedAt;
  return lastActivity ? dayjs.utc(lastActivity).local() : null;
});

const overlayTitle = Vue.computed(() => {
  if (overlayMode.value === 'installing') {
    return `${config.isServerInstalled ? 'Upgrading' : 'Installing'} Your ${serverType()} Machine...`;
  }
  if (overlayMode.value === 'installComplete') {
    return `${serverType()} Machine Ready`;
  }
  if (overlayMode.value === 'error') {
    return `Error Installing Your ${serverType()} Machine`;
  }
  return `${serverType()} Machine Details`;
});

function serverType() {
  if (serverDetails.value.type === ServerType.LocalComputer) {
    return 'Local';
  }

  return 'Cloud';
}

function serverIdentity() {
  if (serverDetails.value.type === ServerType.LocalComputer) {
    return 'Local computer';
  }
  if (serverDetails.value.type === ServerType.DigitalOcean) {
    return `${serverDetails.value.ipAddress} server on DigitalOcean`;
  }
  return `${serverDetails.value.ipAddress} server`;
}

function closeOverlay() {
  isOpen.value = false;
  showInstallComplete.value = false;
}

function formatBlock(blockNumber?: number) {
  if (blockNumber === undefined) return '--';
  return blockNumber.toLocaleString();
}

function openTroubleshooting() {
  basicEmitter.emit('openTroubleshootingOverlay', { screen: 'overview' });
}

basicEmitter.on('openServerOverlay', async () => {
  showInstallComplete.value = false;
  isOpen.value = true;
  await refreshBeaconSyncSettings();
  await bot.refreshState().catch(() => undefined);
});

Vue.watch(isInstalling, (current, previous) => {
  if (!isOpen.value) return;
  if (previous && !current && !hasError.value) {
    showInstallComplete.value = true;
  }
  if (current) {
    showInstallComplete.value = false;
  }
});

Vue.watch(hasError, hasInstallerError => {
  if (hasInstallerError) {
    showInstallComplete.value = false;
  }
});

Vue.onMounted(async () => {
  await config.load();
  isLoaded.value = true;
  await refreshBeaconSyncSettings();
});

async function setBeaconSync(args: { disable?: boolean; nextBeaconApiUrl?: string } = {}) {
  const { disable, nextBeaconApiUrl } = args;
  beaconSyncActionError.value = '';
  beaconSyncActionMessage.value = '';
  isBeaconSyncSaving.value = true;

  let beaconApiUrl = '';
  if (!disable) {
    beaconApiUrl = nextBeaconApiUrl?.trim() ?? '';
    if (!beaconApiUrl && !defaultBeaconApiUrl.value) {
      beaconSyncActionError.value = 'A beacon API URL is required to activate syncing.';
      isBeaconSyncSaving.value = false;
      return;
    }
  }

  const savedBeaconApiUrl = disable ? '' : beaconApiUrl || undefined;
  const shouldBeEnabled = !disable && !!getEthereumBeaconApiUrl(savedBeaconApiUrl);
  const previousBeaconApiUrl = config.ethereumBeaconApiUrl;

  try {
    config.ethereumBeaconApiUrl = savedBeaconApiUrl;
    await config.save();
    await installer.updateServerConfig();
    await refreshBeaconSyncSettings();
    await waitForBeaconSyncState(shouldBeEnabled);
    beaconSyncActionMessage.value = disable ? 'Beacon sync disabled.' : 'Beacon sync settings applied.';
  } catch (error) {
    config.ethereumBeaconApiUrl = previousBeaconApiUrl;
    await config.save().catch(() => undefined);
    beaconSyncActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isBeaconSyncSaving.value = false;
  }
}

async function refreshBeaconSyncSettings() {
  beaconSyncActionError.value = '';
  beaconApiUrlInput.value = config.ethereumBeaconApiUrl === '' ? '' : effectiveBeaconApiUrl.value;
}

async function waitForBeaconSyncState(shouldBeEnabled: boolean) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    await bot.refreshState().catch(() => undefined);
    const mode = bot.state?.ethereumSync?.mode;

    if (shouldBeEnabled) {
      if (mode && mode !== 'disabled') return;
    } else if (!mode || mode === 'disabled') {
      return;
    }

    await new Promise(resolve => window.setTimeout(resolve, 1_000));
  }
}

function formatBeaconSyncStatus(
  mode?: typeof ethereumSyncState.value extends { mode: infer T } ? T : string,
  lastError?: string,
) {
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
      return effectiveBeaconApiUrl.value ? 'Configured' : 'Disabled';
  }
}
</script>
