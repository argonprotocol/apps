<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="min-w-7/12 max-h-11/12 min-h-60">
    <template #title>
      <div v-if="activeScreen !== 'overview'" class="flex flex-row items-center hover:bg-[#f1f3f7] rounded-md p-1 pl-0 mr-2 cursor-pointer">
        <ChevronLeftIcon @click="goTo('overview')" class="w-6 h-6 cursor-pointer relative -top-0.25" />
      </div>
      <DialogTitle v-if="activeScreen === 'overview'" class="text-2xl font-bold grow">Troubleshooting</DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'server-diagnostics'" class="text-2xl font-bold grow">Server Diagnostics</DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'data-and-log-files'" class="text-2xl font-bold grow">Data and Logging</DialogTitle>
      <DialogTitle v-else-if="activeScreen === 'options-for-restart'" class="text-2xl font-bold grow">Advanced Restart</DialogTitle>
    </template>
    <div v-if="activeScreen === 'overview'">
      <ul class="flex flex-row items-center w-full text-center space-x-2 font-bold">
        <li @click="goTo('server-diagnostics')" class="flex flex-col w-1/3 items-center cursor-pointer py-10 hover:bg-slate-100 rounded-md">
          <DiagnosticIcon class="w-14 h-14 inline-block mb-2" />
          Server Diagnostics
        </li>
        <li @click="goTo('data-and-log-files')" class="flex flex-col w-1/3 items-center cursor-pointer py-10 hover:bg-slate-100 rounded-md">
          <LogsIcon class="w-14 h-14 inline-block mb-2" />
          Data and Logging Files
        </li>
        <li @click="goTo('options-for-restart')" class="flex flex-col w-1/3 items-center cursor-pointer py-10 hover:bg-slate-100 rounded-md">
          <RestartIcon class="w-14 h-14 inline-block mb-2" />
          Advanced Restart
        </li>
      </ul>
    </div>
    <ServerDiagnostics v-else-if="activeScreen === 'server-diagnostics'" />
    <DataAndLogFiles v-else-if="activeScreen === 'data-and-log-files'" />
    <AdvancedRestart v-else-if="activeScreen === 'options-for-restart'" />
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter';
import Draggable from './helpers/Draggable.ts';
import ServerDiagnostics from './troubleshooting/ServerDiagnostics.vue';
import DataAndLogFiles from './troubleshooting/DataAndLogFiles.vue';
import AdvancedRestart from './troubleshooting/AdvancedRestart.vue';
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import DiagnosticIcon from '../assets/diagnostics.svg?component';
import LogsIcon from '../assets/logs.svg?component';
import RestartIcon from '../assets/restart.svg?component';
import Overlay from './Overlay.vue';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const activeScreen = Vue.ref('overview');
const draggable = Vue.reactive(new Draggable());

function goTo(screen: 'overview' | 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart') {
  activeScreen.value = screen;
}

basicEmitter.on('openTroubleshootingOverlay', async (data: any) => {
  isOpen.value = true;
  isLoaded.value = true;
  activeScreen.value = data?.screen || 'overview';
});

function closeOverlay() {
  isOpen.value = false;
  isLoaded.value = false;
}
</script>
