<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden cursor-default">
    <TopBar />
    <main v-if="controller.isLoaded && !controller.isImporting" class="grow relative h-full overflow-scroll">
      <AlertBars />
      <HomeScreen v-if="showHomeScreen" />
      <MiningScreen v-if="showMiningScreen" />
      <VaultingScreen v-else-if="controller.screenKey === ScreenKey.Vaulting" />
    </main>
    <div v-else class="grow relative">
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </div>
    <template v-if="config.isLoaded">
      <Portfolio />
      <template v-if="showMiningScreen">
        <SyncingOverlay v-if="bot.isSyncing" />
      </template>
      <BootingOverlay v-if="config.isBootingUpPreviousWalletHistory && !bot.isSyncing" />
      <ServerConnectOverlay />
      <WalletOverlay />
      <MoveCapitalOverlay />
      <WalletFundingReceivedOverlay />
      <ServerRemoveOverlay />
      <SecuritySettingsOverlay />
      <ImportAccountOverlay />
      <BotEditOverlay />
      <!-- <ProvisioningCompleteOverlay /> -->
      <AboutOverlay />
      <JurisdictionOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <WelcomeOverlay v-else-if="config.showWelcomeOverlay" />
    </template>
    <TroubleshootingOverlay />
    <ImportingOverlay />
    <AppUpdatesOverlay />
    <HowMiningWorksOverlay />
    <HowVaultingWorksOverlay />
  </div>
</template>

<script setup lang="ts">
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './OperationsAppMenu.ts';
import HomeScreen from './screens-operations/HomeScreen.vue';
import MiningScreen from './screens-operations/MiningScreen.vue';
import VaultingScreen from './screens-operations/VaultingScreen.vue';
import ServerConnectOverlay from './overlays/ServerConnectOverlay.vue';
import WalletOverlay from './overlays/WalletOverlay.vue';
import ServerRemoveOverlay from './overlays/ServerRemoveOverlay.vue';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
import SyncingOverlay from './overlays/SyncingOverlay.vue';
import TopBar from './navigation-operations/TopBar.vue';
import { useController } from './stores/controller';
import { getConfig } from './stores/config';
import { useTour } from './stores/tour';
import { getBot } from './stores/bot';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from './overlays/AboutOverlay.vue';
import JurisdictionOverlay from './overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from './overlays/Troubleshooting.vue';
import ImportingOverlay from './overlays/ImportingOverlay.vue';
import BootingOverlay from './overlays/BootingOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import AlertBars from './navigation-shared/AlertBars.vue';
import HowMiningWorksOverlay from './overlays/bot/HowMiningWorks.vue';
import HowVaultingWorksOverlay from './overlays/vault/HowVaultingWorks.vue';
import { ScreenKey } from './interfaces/IConfig.ts';
import WelcomeOverlay from './overlays/WelcomeOverlay.vue';
import WelcomeTour from './overlays/WelcomeTour.vue';
import BotEditOverlay from './overlays/BotEditOverlay.vue';
import WalletFundingReceivedOverlay from './overlays/WalletFundingReceivedOverlay.vue';
import Portfolio from './panels/Portfolio.vue';
import MoveCapitalOverlay from './overlays/MoveCapitalOverlay.vue';

const controller = useController();
const config = getConfig();
const tour = useTour();
const bot = getBot();

const showHomeScreen = Vue.computed(() => {
  return controller.screenKey === ScreenKey.Home;
});

const showMiningScreen = Vue.computed(() => {
  return controller.screenKey === ScreenKey.Mining;
});

const order = [ScreenKey.Home, ScreenKey.Mining, ScreenKey.Vaulting];
function keydownHandler(event: KeyboardEvent) {
  // Check for CMD+Shift+[ (mining panel)
  const currentOrder = order.indexOf(controller.screenKey);
  if (event.metaKey && event.shiftKey && event.key === '[') {
    event.preventDefault();
    const left = (currentOrder - 1 + order.length) % order.length;
    controller.setScreenKey(order[left]);
  }
  // Check for CMD+Shift+] (vaulting panel)
  else if (event.metaKey && event.shiftKey && event.key === ']') {
    event.preventDefault();
    const right = (currentOrder + 1) % order.length;
    controller.setScreenKey(order[right]);
  }
}

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onMounted(async () => {
  // Add keyboard shortcuts for panel switching
  document.addEventListener('keydown', keydownHandler);
});

Vue.onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydownHandler);
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});

createMenu();
</script>
