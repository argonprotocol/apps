<template>
  <Overlay
    :isOpen="isOpen"
    @close="closeOverlay"
    @esc="closeOverlay"
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
      <DialogTitle v-else-if="activeScreen === 'find-missing-data'" class="grow text-2xl font-bold">
        Find Missing Data
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'data-and-log-files'" class="grow text-2xl font-bold">
        Data and Logging
      </DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'options-for-restart'" class="grow text-2xl font-bold">
        Advanced Restart
      </DialogTitle>
    </template>
    <div v-if="activeScreen === 'overview'">
      <ul class="mt-6 flex flex-col px-3">
        <li
          @click="goTo('find-missing-data')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent">
          <MagnifyingGlassIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 text-slate-600 opacity-70" />
          Find Missing Data
        </li>
        <li
          @click="goTo('data-and-log-files')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent">
          <LogsIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          View Data and Logs
        </li>
        <li
          @click="goTo('server-diagnostics')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent"
          v-if="config.isMiningMachineCreated">
          <DiagnosticIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Server Diagnostics
        </li>
        <li class="my-4 h-[1px] border-t border-dashed border-slate-300" />
        <li
          @click="goTo('options-for-restart')"
          class="group hover:text-argon-600 hover:to-argon-menu-hover/70 flex cursor-pointer flex-row items-center rounded-md py-4 hover:bg-gradient-to-r hover:from-transparent">
          <RestartIcon class="group-hover:text-argon-600 mr-2 h-5 w-5 opacity-70" />
          Advanced Restart
        </li>
      </ul>
    </div>
    <ServerDiagnostics v-else-if="activeScreen === 'server-diagnostics'" />
    <DataAndLogFiles v-else-if="activeScreen === 'data-and-log-files'" />
    <FindMissingData v-else-if="activeScreen === 'find-missing-data'" />
    <AdvancedRestart v-else-if="activeScreen === 'options-for-restart'" />
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter';
import ServerDiagnostics from './troubleshooting/ServerDiagnostics.vue';
import DataAndLogFiles from './troubleshooting/DataAndLogFiles.vue';
import AdvancedRestart from './troubleshooting/AdvancedRestart.vue';
import { ChevronLeftIcon, MagnifyingGlassIcon } from '@heroicons/vue/24/outline';
import DiagnosticIcon from '../assets/diagnostics.svg?component';
import LogsIcon from '../assets/logs.svg?component';
import RestartIcon from '../assets/restart.svg?component';
import Overlay from './Overlay.vue';
import { getConfig } from '../stores/config.ts';
import FindMissingData from './troubleshooting/FindMissingData.vue';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const config = getConfig();

const activeScreen = Vue.ref('overview');

function goTo(
  screen: 'overview' | 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart' | 'find-missing-data',
) {
  activeScreen.value = screen;
}

basicEmitter.on('openTroubleshootingOverlay', async (data: any) => {
  await config.isLoadedPromise;
  isOpen.value = true;
  isLoaded.value = true;
  activeScreen.value = data?.screen || 'overview';
});

function closeOverlay() {
  isOpen.value = false;
  isLoaded.value = false;
}
</script>
