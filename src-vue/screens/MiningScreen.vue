<!-- prettier-ignore -->
<template>
  <BlankSlate v-if="!config.isPreparingMinerSetup && !config.miningAccountPreviousHistory" />
  <FinalSetupChecklist v-else-if="!config.isMinerReadyToInstall" />
  <CloudMachineIsInstalling v-else-if="!config.isMinerInstalling" />
  <StartingBot v-else-if="!bot.isReady" />
  <Dashboard v-else-if="config.hasMiningSeats" />
  <FirstAuction v-else />
</template>

<script setup lang="ts">
import BlankSlate from './mining-screen/BlankSlate.vue';
import FinalSetupChecklist from './mining-screen/FinalSetupChecklist.vue';
import CloudMachineIsInstalling from './mining-screen/CloudMachineIsInstalling.vue';
import FirstAuction from './mining-screen/FirstAuction.vue';
import Dashboard from './mining-screen/Dashboard.vue';
import StartingBot from './mining-screen/StartingBot.vue';
import { getConfig } from '../stores/config';
import { getBot } from '../stores/bot';

const config = getConfig();
const bot = getBot();
</script>
