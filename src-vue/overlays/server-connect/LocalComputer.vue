<template>
  <div class="mx-5 flex h-full grow flex-col p-3">
    <DialogDescription :class="[blockedPorts.length ? 'opacity-30' : 'opacity-80']" class="mt-4 pr-10 font-light">
      Argon Investor Console allows you to use your laptop or desktop computer as a server. In many ways this is the
      easiest and cheapest way to get started, but it comes with some caveats. It requires you to keep this app running
      and connected to the internet at all times. It also requires you to install Docker.
    </DialogDescription>

    <div v-if="blockedPorts.length" Warning>
      <strong>INELIGIBLE:</strong>
      This option requires that port{{ blockedPorts.length === 1 ? '' : 's' }}
      <strong class="font-bold">{{ formatPorts(blockedPorts) }}</strong>
      be available for Argon's mining machine. It seems that some other application is using these ports. Please release
      these ports on your computer or use another server option.
    </div>

    <div v-else Warning>
      <strong>WARNING:</strong>
      You should ONLY proceed if you can keep this app running and connected to the internet at all times. If this app
      closes for any reason, you will lose all revenue while its closed, and you will not be able to claw it back. This
      is because blocks are only distributed to active miners.
    </div>

    <div
      :class="{ 'opacity-30': blockedPorts.length }"
      class="mx-auto flex w-7/12 min-w-[630px] grow flex-col justify-center">
      <section class="-mt-5 flex w-full flex-row content-start items-start">
        <div class="relative mt-0.5 mr-4 w-14">
          <div
            :class="{
              'bg-gray-500': isCheckingDiskSpace,
              'bg-argon-500': hasEnoughDiskSpace,
              'bg-red-600': !isCheckingDiskSpace && !hasEnoughDiskSpace,
            }"
            class="bg-argon-500 absolute -top-1 -right-1 flex h-8 w-8 items-center justify-center rounded-sm border-2 border-white">
            <LoadingDotsIcon v-if="isCheckingDiskSpace" class="w-9/12" />
            <CheckmarkIcon v-else-if="hasEnoughDiskSpace" class="w-9/12" />
            <AlertIcon v-else class="w-9/12 text-white" />
          </div>
          <DatabaseIcon class="w-full" />
        </div>

        <div class="flex grow flex-col">
          <header class="text-2xl font-bold text-slate-800/80">
            <template v-if="isCheckingDiskSpace">Checking Available Disk Space</template>
            <template v-if="hasEnoughDiskSpace">Found 100+ GB of Available Disk Space</template>
            <template v-else>Could Not Find Enough Disk Space</template>
          </header>
          <p class="mt-1">Argon Miner requires a minimum of 100GB of available hard disk space.</p>
          <div class="text-md mt-3 border-t border-b border-slate-400/40 py-1 font-mono uppercase">
            {{ numeral(availableGBs).format('0,0.[000]') }} GB of available space was found on this machine
          </div>
        </div>
      </section>

      <section class="mt-[9%] flex w-full flex-row content-start items-start">
        <div class="relative mt-1 mr-4 w-14 min-w-14">
          <div
            :class="[isDockerStarted ? 'bg-argon-500' : 'bg-gray-500']"
            class="bg-argon-500 absolute -top-1.5 -right-1 flex h-8 w-8 items-center justify-center rounded-sm border-2 border-white">
            <CheckmarkIcon v-if="isDockerStarted" class="w-9/12" />
            <LoadingDotsIcon v-else class="w-9/12" />
          </div>
          <DockerIcon class="w-full" />
        </div>
        <div class="flex grow flex-col">
          <header class="text-2xl font-bold text-slate-800/80">
            {{ isDockerStarted ? 'Found' : 'Checking for' }} Docker v27+
          </header>
          <p class="mt-1">
            You must have Docker v27+ installed and running on this machine. If you haven't installed Docker,
            <a @click="openDockerInstallLink" class="!text-argon-600 cursor-pointer">
              click here to open the download page
            </a>
            .
          </p>
          <p class="mt-3">If you've already installed Docker, make sure it is running.</p>
          <div class="text-md mt-3 border-t border-b border-slate-400/40 py-1 font-mono uppercase">
            {{ isDockerStarted ? 'DOCKER VERSION 27+ WAS FOUND RUNNING ON THIS MACHINE' : 'WAITING...' }}
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogDescription } from 'reka-ui';
import DockerIcon from '../../assets/docker.svg?component';
import DatabaseIcon from '../../assets/database.svg?component';
import CheckmarkIcon from '../../assets/checkmark.svg?component';
import AlertIcon from '../../assets/alert.svg?component';
import LoadingDotsIcon from '../../assets/loading-dots.svg?component';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { platformType } from '../../tauri-controls/utils/os.ts';
import { IServerConnectChildExposed } from '../ServerConnectOverlay.vue';
import { IConfigServerCreationLocalComputer } from '../../interfaces/IConfig';
import { invokeWithTimeout } from '../../lib/tauriApi';
import numeral from '../../lib/numeral';
import { MiningMachine } from '../../lib/MiningMachine.ts';
import { IS_TEST } from '../../lib/Env.ts';

const emit = defineEmits(['ready']);

const isDockerStarted = Vue.ref(false);
const blockedPorts = Vue.ref([] as number[]);

const isCheckingDiskSpace = Vue.ref(true);
const hasEnoughDiskSpace = Vue.ref(false);
const availableGBs = Vue.ref(0);

let checkDockerInterval: number | undefined;

async function checkDockerDependencies() {
  const dockerChecks = await MiningMachine.runDockerChecks();
  isDockerStarted.value = dockerChecks.isDockerStarted;
  blockedPorts.value = dockerChecks.blockedPorts;
  calculateIsReady();

  if (!isDockerStarted.value) {
    checkDockerInterval = setTimeout(checkDockerDependencies, 1000) as unknown as number;
  }
}

function calculateIsReady() {
  if (hasEnoughDiskSpace.value && isDockerStarted.value && !blockedPorts.value.length) {
    emit('ready', true);
  } else {
    emit('ready', false);
  }
}

function formatPorts(ports: number[]): string {
  if (ports.length === 0) return '';
  if (ports.length === 1) return ports[0].toString();
  if (ports.length === 2) return `${ports[0]} and ${ports[1]}`;
  return `${ports.slice(0, -1).join(', ')}, and ${ports[ports.length - 1]}`;
}

function openDockerInstallLink() {
  const install = {
    gnome: 'linux',
    macos: 'mac-install',
    windows: 'windows-install',
  }[platformType];
  const url = `https://docs.docker.com/desktop/setup/install/${install}/`;
  void tauriOpenUrl(url);
}

async function connect(): Promise<IConfigServerCreationLocalComputer> {
  return {};
}

async function checkAvailableDiskSpace() {
  const bytes: number = await invokeWithTimeout('calculate_free_space', { path: '/' }, 10_000);
  availableGBs.value = bytes / 1024 / 1024 / 1024;
  isCheckingDiskSpace.value = false;
  hasEnoughDiskSpace.value = availableGBs.value >= 100;
  if (IS_TEST) {
    hasEnoughDiskSpace.value = true;
    availableGBs.value = 100;
  }
  calculateIsReady();
}

Vue.onMounted(async () => {
  void checkDockerDependencies();
  void checkAvailableDiskSpace();
});

Vue.onBeforeUnmount(() => {
  if (checkDockerInterval) clearTimeout(checkDockerInterval);
});

defineExpose<IServerConnectChildExposed>({ connect });
</script>

<style scoped>
@reference "../../main.css";

div[Warning] {
  @apply mt-4 rounded-md border border-yellow-700/20 bg-yellow-50/50 px-5 py-4;
  strong {
    @apply text-red-500;
  }
}
</style>
