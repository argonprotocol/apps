<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="min-h-60 overflow-scroll rounded-lg border border-black/40 bg-white px-3 pb-4 shadow-xl focus:outline-none">
    <template #title>
      <div
        v-if="activeScreen !== 'overview'"
        class="mr-2 flex cursor-pointer flex-row items-center rounded-md p-1 pl-0 hover:bg-[#f1f3f7]">
        <ChevronLeftIcon @click="goTo('overview')" class="relative -top-0.25 h-6 w-6 cursor-pointer" />
      </div>

      <DialogTitle v-if="activeScreen === 'overview'" class="grow text-2xl font-bold">Troubleshooting</DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'server-diagnostics'" class="grow text-2xl font-bold">
        Server Diagnostics
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'missing-data-scanner'" class="grow text-2xl font-bold">
        Missing Data Scanner
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'data-and-logs-dir'" class="grow text-2xl font-bold">
        Data and Logging
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'debug-package'" class="grow text-2xl font-bold">
        Debugging Package
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'ssh'" class="grow text-2xl font-bold">
        Open SSH to Mining Machine
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'options-for-restart'" class="grow text-2xl font-bold">
        Advanced Restart
      </DialogTitle>
    </template>
    <div v-if="activeScreen === 'overview'">
      <ul class="mt-3 flex flex-col px-3">
        <li
          @click="goTo('data-and-logs-dir')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent">
          <LogsIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          View Data and Logs Dir
        </li>
        <li
          @click="goTo('debug-package')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent">
          <DebugIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Download Debugging Package
        </li>
        <li
          @click="goTo('missing-data-scanner')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent"
          :class="{ 'opacity-50 pointer-events-none': localOnly }"
          :aria-disabled="localOnly">
          <ScannerIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 text-slate-600 opacity-70" />
          Run Missing Data Scanner
        </li>
        <li
          @click="goTo('server-diagnostics')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent"
          :class="{ 'opacity-50 pointer-events-none': localOnly || !config?.isServerAdded }"
          :aria-disabled="localOnly || !config?.isServerAdded"
        >
          <DiagnosticIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Run Server Diagnostics
        </li>
        <li
          @click="goTo('ssh')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent"
          :class="{ 'opacity-50 pointer-events-none': localOnly || !config?.isServerAdded }"
          :aria-disabled="localOnly || !config?.isServerAdded"
        >
          <CommandLineIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Open SSH to Mining Machine
        </li>
        <li class="my-4 h-[1px] border-t border-dashed border-slate-300" />
        <li
          @click="goTo('options-for-restart')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent"
          :class="{ 'opacity-50 pointer-events-none': localOnly }"
          :aria-disabled="localOnly">
          <RestartIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Advanced Restart
        </li>
      </ul>
    </div>
    <ServerDiagnostics v-else-if="activeScreen === 'server-diagnostics'" />
    <DataAndLogFiles v-else-if="activeScreen === 'data-and-logs-dir'" />
    <DebugPackage v-else-if="activeScreen === 'debug-package'" :include-server="!localOnly" />
    <SSHAccess v-else-if="activeScreen === 'ssh'" />
    <MissingDataScanner v-else-if="activeScreen === 'missing-data-scanner'" />
    <AdvancedRestart v-else-if="activeScreen === 'options-for-restart'" />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import ServerDiagnostics from './troubleshooting/ServerDiagnostics.vue';
import DataAndLogFiles from './troubleshooting/DataAndLogFiles.vue';
import DebugPackage from './troubleshooting/DebugPackage.vue';
import AdvancedRestart from './troubleshooting/AdvancedRestart.vue';
import { ChevronLeftIcon, CommandLineIcon } from '@heroicons/vue/24/outline';
import DiagnosticIcon from '../assets/diagnostics.svg?component';
import LogsIcon from '../assets/logs.svg?component';
import RestartIcon from '../assets/restart.svg?component';
import DebugIcon from '../assets/debug.svg?component';
import ScannerIcon from '../assets/scanner.svg?component';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';
import MissingDataScanner from './troubleshooting/MissingDataScanner.vue';
import SSHAccess from './troubleshooting/SSHAccess.vue';

const { localOnly = false } = defineProps<{ localOnly?: boolean }>();
const isOpen = Vue.ref(false);
const config = Vue.computed(() => {
  if (!localOnly) return getConfig();
});

const activeScreen = Vue.ref('overview');

function goTo(screen: string) {
  if (localOnly && !['overview', 'data-and-logs-dir', 'debug-package'].includes(screen)) {
    activeScreen.value = 'overview';
    return;
  }
  activeScreen.value = screen;
}

function openOverlay(data: { screen?: string }) {
  isOpen.value = true;
  goTo(data?.screen ?? 'overview');
}

Vue.watch(
  () => localOnly,
  () => goTo(activeScreen.value),
);
basicEmitter.on('openTroubleshootingOverlay', openOverlay);
Vue.onBeforeUnmount(() => basicEmitter.off('openTroubleshootingOverlay', openOverlay));

function closeOverlay() {
  isOpen.value = false;
}
</script>
