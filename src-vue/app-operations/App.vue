<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden cursor-default">
    <TopBar />
    <main v-if="controller.isLoaded && !controller.isImporting" class="grow relative h-full overflow-scroll">
      <AlertBars />
      <HomeScreen v-if="controller.selectedTab === OperationsTab.Home" />
      <MiningScreen v-if="controller.selectedTab === OperationsTab.Mining" />
      <VaultingScreen v-else-if="controller.selectedTab === OperationsTab.Vaulting" />
    </main>
    <div v-else class="grow relative">
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </div>
    <template v-if="config.isLoaded">
      <Portfolio />
      <template v-if="controller.selectedTab === OperationsTab.Mining">
        <SyncingOverlay v-if="bot.isSyncing" />
      </template>
      <BootingOverlay v-if="config.isBootingUpPreviousWalletHistory && !bot.isSyncing" />
      <ServerConnectPanel />
      <WalletOverlay />
      <OnboardingWalletOverlay />
      <MoveCapitalOverlay />
      <WalletFundingReceivedOverlay />
      <ServerRemoveOverlay />
      <OperationalOverlay />
      <OperationalFinishOverlay />
      <SecuritySettingsOverlay />
      <ImportAccountOverlay />
      <BotEditOverlay />
      <!-- <ProvisioningCompleteOverlay /> -->
      <AboutOverlay />
      <ProfileOverlay />
      <JurisdictionOverlay />
      <OperationalInvitesOverlay />
      <VaultMembersOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <WelcomeOverlay v-else-if="config.showWelcomeOverlay" />
    </template>
    <ServerOverlay />
    <TroubleshootingOverlay />
    <AppUpdatesOverlay />
  </div>
</template>

<script setup lang="ts">
import '../lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './NativeMenu.ts';
import HomeScreen from './screens/HomeScreen.vue';
import MiningScreen from './screens/MiningScreen.vue';
import VaultingScreen from './screens/VaultingScreen.vue';
import ServerConnectPanel from '../panels/ServerConnectPanel.vue';
import WalletOverlay from './overlays/WalletOverlay.vue';
import OnboardingWalletOverlay from './overlays/OnboardingWalletOverlay.vue';
import ServerRemoveOverlay from './overlays/ServerRemoveOverlay.vue';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
import SyncingOverlay from './overlays/SyncingOverlay.vue';
import TopBar from './navigation/TopBar.vue';
import { OperationsTab, useOperationsController } from '../stores/operationsController.ts';
import { getConfig } from '../stores/config.ts';
import { useTour } from '../stores/tour.ts';
import { getBot } from '../stores/bot.ts';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from '../app-shared/overlays/AboutOverlay.vue';
import JurisdictionOverlay from '../app-shared/overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from '../app-shared/overlays/Troubleshooting.vue';
import BootingOverlay from '../app-shared/overlays/BootingOverlay.vue';
import WelcomeOverlay from '../app-shared/overlays/WelcomeOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import AlertBars from '../app-shared/navigation/AlertBars.vue';
import WelcomeTour from './overlays/WelcomeTour.vue';
import BotEditOverlay from './overlays/BotEditOverlay.vue';
import WalletFundingReceivedOverlay from './overlays/WalletFundingReceivedOverlay.vue';
import Portfolio from '../panels/Portfolio.vue';
import MoveCapitalOverlay from './overlays/MoveCapitalOverlay.vue';
import ServerOverlay from './overlays/ServerOverlay.vue';
import VaultMembersOverlay from './overlays/VaultMembersOverlay.vue';
import OperationalOverlay from './overlays/OperationalOverlay.vue';
import OperationalFinishOverlay from './overlays/OperationalFinishOverlay.vue';
import { CloseRequestedEvent, getCurrentWindow } from '@tauri-apps/api/window';
import ProfileOverlay from '../app-shared/overlays/ProfileOverlay.vue';
import { checkInstallerIfCloseAllowed } from '../stores/installer.ts';
import OperationalInvitesOverlay from './overlays/OperationalInvitesOverlay.vue';

const controller = useOperationsController();
const config = getConfig();
const tour = useTour();
const bot = getBot();

const order = [OperationsTab.Mining, OperationsTab.Home, OperationsTab.Vaulting];
function keydownHandler(event: KeyboardEvent) {
  // Check for CMD+Shift+[ (mining panel)
  const currentOrder = order.indexOf(controller.selectedTab);
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

  const appWindow = getCurrentWindow();
  await appWindow.onCloseRequested(async (event: CloseRequestedEvent) => {
    const isCloseAllowed = await checkInstallerIfCloseAllowed();
    if (!isCloseAllowed) {
      event.preventDefault();
    }
  });
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
