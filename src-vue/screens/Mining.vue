<!-- prettier-ignore -->
<template>
  <div data-testid="MiningScreen" class="relative isolate h-full w-full">
    <BlankSlate v-if="config.miningSetupStatus === MiningSetupStatus.None && !config.miningBotAccountPreviousHistory" />
    <SetupChecklist v-else-if="config.miningSetupStatus === MiningSetupStatus.Checklist" />
    <SetupInstalling v-else-if="config.miningSetupStatus === MiningSetupStatus.Installing" />
    <template v-else-if="config.miningSetupStatus === MiningSetupStatus.Finished">
      <Dashboard v-if="config.hasMiningSeats && (bot.isReady || config.isServerInstalling)" />
      <StartingBot v-else-if="!bot.isReady" />
      <FirstAuction v-else />
    </template>
    <SyncingOverlay v-if="bot.isSyncing" />
    <BiddingBotOverlay :isOpen="isBiddingBotOpen" @close="isBiddingBotOpen = false" />
    <ActiveSeatsOverlay :isOpen="isActiveSeatsOpen" @close="isActiveSeatsOpen = false" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BlankSlate from './mining-screen/BlankSlate.vue';
import SetupChecklist from './mining-screen/SetupChecklist.vue';
import SetupInstalling from './mining-screen/SetupInstalling.vue';
import FirstAuction from './mining-screen/FirstAuction.vue';
import Dashboard from './mining-screen/Dashboard.vue';
import StartingBot from './mining-screen/StartingBot.vue';
import SyncingOverlay from '../overlays/SyncingOverlay.vue';
import ActiveSeatsOverlay from '../overlays/mining/ActiveSeatsOverlay.vue';
import BiddingBotOverlay from '../overlays/mining/BiddingBotOverlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';
import { getBot } from '../stores/bot.ts';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';

const config = getConfig();
const bot = getBot();
const isBiddingBotOpen = Vue.ref(false);
const isActiveSeatsOpen = Vue.ref(false);

function openBiddingBot() {
  isBiddingBotOpen.value = true;
}

function openActiveSeats() {
  isActiveSeatsOpen.value = true;
}

basicEmitter.on('openMiningBiddingBotOverlay', openBiddingBot);
basicEmitter.on('openMiningActiveSeatsOverlay', openActiveSeats);

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openMiningBiddingBotOverlay', openBiddingBot);
  basicEmitter.off('openMiningActiveSeatsOverlay', openActiveSeats);
});
</script>
