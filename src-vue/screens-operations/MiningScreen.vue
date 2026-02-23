<!-- prettier-ignore -->
<template>
  <div data-testid="MiningScreen" class="h-full">
    <BlankSlate v-if="config.miningSetupStatus === MiningSetupStatus.None && !config.miningBotAccountPreviousHistory" />
    <SetupChecklist v-else-if="config.miningSetupStatus === MiningSetupStatus.Checklist" />
    <SetupInstalling v-else-if="config.miningSetupStatus === MiningSetupStatus.Installing" />
    <template v-else-if="config.miningSetupStatus === MiningSetupStatus.Finished">
      <StartingBot v-if="!bot.isReady && !config.isServerInstalling" />
      <Dashboard v-else-if="config.hasMiningSeats" />
      <FirstAuction v-else />
    </template>
  </div>
</template>

<script setup lang="ts">
import BlankSlate from './mining-screen/BlankSlate.vue';
import SetupChecklist from './mining-screen/SetupChecklist.vue';
import SetupInstalling from './mining-screen/SetupInstalling.vue';
import FirstAuction from './mining-screen/FirstAuction.vue';
import Dashboard from './mining-screen/Dashboard.vue';
import StartingBot from './mining-screen/StartingBot.vue';
import { getConfig } from '../stores/config';
import { getBot } from '../stores/bot';
import { MiningSetupStatus } from '../interfaces/IConfig';

const config = getConfig();
const bot = getBot();
</script>
