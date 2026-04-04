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
      <VaultInvitesOverlay />
      <VaultMembersOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <WelcomeOverlay v-else-if="config.showWelcomeOverlay" />
    </template>
    <ServerOverlay />
    <TroubleshootingOverlay />
    <ImportingAccountOverlay />
    <AppUpdatesOverlay />
  </div>
</template>

<script setup lang="ts">
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './OperationsAppMenu.ts';
import HomeScreen from './screens-operations/HomeScreen.vue';
import MiningScreen from './screens-operations/MiningScreen.vue';
import VaultingScreen from './screens-operations/VaultingScreen.vue';
import ServerConnectPanel from './panels/ServerConnectPanel.vue';
import WalletOverlay from './overlays-operations/WalletOverlay.vue';
import OnboardingWalletOverlay from './overlays-operations/OnboardingWalletOverlay.vue';
import ServerRemoveOverlay from './overlays-operations/ServerRemoveOverlay.vue';
import SecuritySettingsOverlay from './overlays-operations/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays-operations/ImportAccountOverlay.vue';
import SyncingOverlay from './overlays-operations/SyncingOverlay.vue';
import TopBar from './navigation-operations/TopBar.vue';
import { useOperationsController, OperationsTab } from './stores/operationsController.ts';
import { getConfig } from './stores/config';
import { useTour } from './stores/tour';
import { getBot } from './stores/bot';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from './overlays-shared/AboutOverlay.vue';
import JurisdictionOverlay from './overlays-shared/JurisdictionOverlay.vue';
import TroubleshootingOverlay from './overlays-shared/Troubleshooting.vue';
import ImportingAccountOverlay from './overlays-operations/ImportingAccountOverlay.vue';
import BootingOverlay from './overlays-shared/BootingOverlay.vue';
import AppUpdatesOverlay from './overlays-operations/AppUpdatesOverlay.vue';
import AlertBars from './navigation-shared/AlertBars.vue';
import WelcomeOverlay from './overlays-operations/WelcomeOverlay.vue';
import WelcomeTour from './overlays-operations/WelcomeTour.vue';
import BotEditOverlay from './overlays-operations/BotEditOverlay.vue';
import WalletFundingReceivedOverlay from './overlays-operations/WalletFundingReceivedOverlay.vue';
import Portfolio from './panels/Portfolio.vue';
import MoveCapitalOverlay from './overlays-operations/MoveCapitalOverlay.vue';
import ServerOverlay from './overlays-operations/ServerOverlay.vue';
import VaultInvitesOverlay from './overlays-operations/VaultInvitesOverlay.vue';
import VaultMembersOverlay from './overlays-operations/VaultMembersOverlay.vue';
import OperationalOverlay from './overlays-operations/OperationalOverlay.vue';
import OperationalFinishOverlay from './overlays-operations/OperationalFinishOverlay.vue';
import { CloseRequestedEvent, getCurrentWindow } from '@tauri-apps/api/window';
import ProfileOverlay from './overlays-shared/ProfileOverlay.vue';
import { checkInstallerIfCloseAllowed } from './stores/installer.ts';

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
