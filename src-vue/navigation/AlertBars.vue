<!-- prettier-ignore -->
<template>
  <div
    DbMigrationError
    v-if="config.hasDbMigrationError"
    class="group alert-bar error"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon />
    <div class="font-bold grow">DATABASE CORRUPTION. Your database has become corrupted, and requires a hard reset.</div>
    <button
      @click="restartDatabase"
      :disabled="isRestarting"
    >
      Hard Reset
    </button>
  </div>
  <div
    InstallerInBackground
    v-else-if="showInstallerInBackgroundAlert"
    class="group alert-bar info"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon />
    <div class="grow"><span class="font-bold">Installer Is Running In Background</span>. You can close this app and the installer will continue without interruption.</div>
    <button
      @click="hideInstallerInBackgroundAlert = true"
    >
      Okay
    </button>
  </div>
  <div
    BotBroken
    v-else-if="bot.isBroken"
    class="group alert-bar error"
  >
    <AlertIcon />
    <div class="grow"><span class="font-bold">Server Error</span> Your server has encountered an unknown error. Restarting might resolve it.</div>
    <button
      @click="restartBot"
      :disabled="isRestarting"
    >
      {{ isRestarting ? 'Restarting...' : 'Restart' }}
    </button>
  </div>
  <div
    ServerDegraded
    v-if="isApiClientDegraded"
    class="group alert-bar warn">
    <AlertIcon />
    <div class="grow"><span class="font-bold">Degraded Performance</span> The api for Argon is experiencing issues, which might impact some parts of this app (eg, your wallet balance).</div>
  </div>

  <!-- <div
    InsufficientFunds
    v-else-if="hasInsufficientFunds"
    @click="openFundMiningWalletOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">BIDDING DISABLED. Your wallet no longer has enough funds to continue bidding.</div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Add Funds
    </span>
  </div>
  <div
    MaxBudgetTooLow
    v-else-if="maxBudgetIsTooLow"
    @click="openBotCreateOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">
      BIDDING DISABLED. Your bot has stopped submitting bids because your budget has been reached.
    </div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Open Bidding Rules
    </span>
  </div>
  <div
    MaxBidTooLow
    v-else-if="maxBidIsTooLow"
    @click="openBotCreateOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">BIDDING DISABLED. The auction's lowest price has climbed above your Maximum Price.</div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Open Bidding Rules
    </span>
  </div>
  <div
    LowFunds
    v-else-if="hasLowFunds"
    @click="openFundMiningWalletOverlay"
    class="flex flex-row items-center gap-x-3 cursor-pointer bg-argon-500 hover:bg-argon-600 text-white px-3.5 py-2 border-b border-argon-700"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">WARNING. Your mining wallet is low on usable argons which may inhibit bidding.</div>
    <span class="cursor-pointer font-bold inline-block rounded-full bg-argon-700 hover:bg-black/90 px-3">
      Add Funds
    </span>
  </div> -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useConfig } from '../stores/config';
import AlertIcon from '../assets/alert.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import { useStats } from '../stores/stats';
import { useBot } from '../stores/bot';
import Restarter from '../lib/Restarter';
import { getDbPromise } from '../stores/helpers/dbPromise';
import { useInstaller } from '../stores/installer';
import Button from '../tauri-controls/components/Button.vue';
import { getMainchainClients } from '../stores/mainchain.ts';

const stats = useStats();
const config = useConfig();
const bot = useBot();
const installer = useInstaller();
const dbPromise = getDbPromise();
const clients = getMainchainClients();

const isRestarting = Vue.ref(false);
const isApiClientDegraded = Vue.ref(false);

clients.events.on('working', () => {
  isApiClientDegraded.value = false;
});
clients.events.on('degraded', () => {
  isApiClientDegraded.value = true;
});

const hideInstallerInBackgroundAlert = Vue.ref(false);

const showInstallerInBackgroundAlert = Vue.computed(() => {
  if (config.isMinerInstalling) return false;
  return installer.isRunning && installer.isRunningInBackground && !hideInstallerInBackgroundAlert.value;
});

function openBotCreateOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

async function restartDatabase() {
  await config.isLoadedPromise;
  const restarter = new Restarter(dbPromise, config as any);
  await restarter.migrateToFreshLocalDatabase(true);
}

async function restartBot() {
  isRestarting.value = true;
  await bot.restart();
  isRestarting.value = false;
}
</script>
<style scoped>
@reference "../main.css";
.alert-bar {
  @apply flex flex-row items-center gap-x-3 border-b px-3.5 py-2 text-white;
  box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1);
  > svg {
    @apply relative left-1 inline-block h-4 w-4;
  }
  > button {
    @apply inline-block cursor-pointer rounded-full px-3 font-bold;
  }
  &.error {
    @apply bg-argon-error hover:bg-argon-error-darker border-argon-error-darkest;
    > button {
      @apply bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80;
    }
  }
  &.warn {
    @apply bg-argon-500 hover:bg-argon-600 border-argon-700;
    > button {
      @apply bg-argon-700/60 group-hover:border-argon-700 hover:bg-black/80;
    }
  }
  &.info {
    @apply border-b border-lime-700 bg-lime-700/90 hover:bg-lime-700;
    > button {
      @apply bg-lime-700/60 group-hover:bg-lime-800 hover:bg-black/80;
    }
  }
}
</style>
