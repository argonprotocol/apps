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
import BlankSlate from './mining-panel/BlankSlate.vue';
import FinalSetupChecklist from './mining-panel/FinalSetupChecklist.vue';
import CloudMachineIsInstalling from './mining-panel/CloudMachineIsInstalling.vue';
import FirstAuction from './mining-panel/FirstAuction.vue';
import Dashboard from './mining-panel/Dashboard.vue';
import StartingBot from './mining-panel/StartingBot.vue';
import { useConfig } from '../stores/config';
import { useBot } from '../stores/bot';

const config = useConfig();
const bot = useBot();
</script>
