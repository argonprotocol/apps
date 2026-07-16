<!-- prettier-ignore -->
<template>
  <template v-if="shouldShowCompatibilityScreen">
    <RuntimeCompatibilityScreen />
    <SecuritySettingsOverlay />
  </template>
  <div v-else class="h-screen w-screen flex flex-col overflow-hidden cursor-default">
    <TopBar />
    <div v-if="controller.isLoaded && !controller.isImporting" class="flex flex-row grow gap-x-2 px-2 pt-2 pb-2 overflow-scroll">
      <LeftBar />
      <main v-if="controller.isLoaded && !controller.isImporting" class="grow min-h-0 relative flex flex-col overflow-hidden">
        <AlertBars />
        <div
          class="grow min-h-0 flex flex-col overflow-y-auto overflow-x-hidden"
          :class="
            controller.selectedTab === TopTab.ArgonBonds ||
            controller.selectedTab === TopTab.BitcoinLocks ||
            controller.selectedTab === TopTab.BitcoinLoans ||
            controller.selectedTab === TopTab.StableSwaps
              ? 'rounded border-[1px] border-slate-400/40 bg-white shadow-md'
              : ''
          "
        >
          <Dashboard v-if="controller.selectedTab === TopTab.Dashboard" />
          <Network v-else-if="controller.selectedTab === TopTab.Network" />

          <ArgonBonds v-else-if="controller.selectedTab === TopTab.ArgonBonds" />
          <BitcoinLocks v-else-if="controller.selectedTab === TopTab.BitcoinLocks" />
          <BitcoinLoans v-else-if="controller.selectedTab === TopTab.BitcoinLoans" />
          <StableSwaps v-else-if="controller.selectedTab === TopTab.StableSwaps" />

          <Mining v-else-if="controller.selectedTab === TopTab.Mining" />
          <Vaulting v-else-if="controller.selectedTab === TopTab.Vaulting" />
        </div>
      </main>
    </div>
    <div v-else class="grow relative">
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </div>
    <template v-if="config.isLoaded">
      <template v-if="controller.selectedTab === TopTab.Mining">
        <SyncingOverlay v-if="bot.isSyncing" />
      </template>
      <BootingOverlay v-if="config.isBootingUpPreviousWalletHistory && !bot.isSyncing" />
      <ServerConnectPanel />
      <WalletDialogs />
      <TransactionsOverlay />
      <MoveCapitalOverlay />
      <TreasuryBondsOverlay />
      <ArgonotCommitmentOverlay />
      <MintingAuthorityRequestOverlay />
      <GatewayRelayOverlay />
      <ServerSettingsOverlay />
      <ServerRemoveOverlay />
      <OperationalOverlay />
      <OperationalRewardsOverlay />
      <SecuritySettingsOverlay />
      <ImportAccountOverlay />
      <BotEditOverlay />
      <!-- <ProvisioningCompleteOverlay /> -->
      <AboutOverlay />
      <SoftwareInfoOverlay />
      <ProfileOverlay />
      <JurisdictionOverlay />
      <ServerOverlay />
      <TroubleshootingOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <template v-else-if="config.showWelcomeOverlay">
        <WelcomeOverlay />
        <WelcomeToTreasuryOverlay />
      </template>
      <UpgradeToOperationsOverlay />
      <UpgradeToTreasuryOverlay />
    </template>
    <AppUpdatesOverlay />
  </div>
</template>

<script setup lang="ts">
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './NativeMenu.ts';
import Network from './screens/Network.vue';
import Mining from './screens/Mining.vue';
import Vaulting from './screens/Vaulting.vue';
import ServerConnectPanel from './panels/ServerConnectPanel.vue';
import WalletDialogs from './wallets/WalletDialogs.vue';
import TransactionsOverlay from './overlays/TransactionsOverlay.vue';
import ServerRemoveOverlay from './overlays/ServerRemoveOverlay.vue';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
import SyncingOverlay from './overlays/SyncingOverlay.vue';
import TopBar from './navigation/TopBar.vue';
import { TopTab } from './interfaces/IConfig.ts';
import { useCertificationController } from './stores/certificationController.ts';
import { getConfig } from './stores/config.ts';
import { useTour } from './stores/tour.ts';
import { getBot } from './stores/bot.ts';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from './overlays/AboutOverlay.vue';
import SoftwareInfoOverlay from './overlays/SoftwareInfoOverlay.vue';
import JurisdictionOverlay from './overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from './overlays/Troubleshooting.vue';
import BootingOverlay from './overlays/BootingOverlay.vue';
import WelcomeOverlay from './overlays/WelcomeOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import AlertBars from './navigation/AlertBars.vue';
import WelcomeTour from './overlays/WelcomeTour.vue';
import BotEditOverlay from './overlays/BotEditOverlay.vue';
import MoveCapitalOverlay from './overlays/MoveCapitalOverlay.vue';
import TreasuryBondsOverlay from './overlays/TreasuryBondsOverlay.vue';
import ArgonotCommitmentOverlay from './overlays/ArgonotCommitmentOverlay.vue';
import MintingAuthorityRequestOverlay from './overlays/MintingAuthorityRequestOverlay.vue';
import GatewayRelayOverlay from './overlays/GatewayRelayOverlay.vue';
import ServerSettingsOverlay from './overlays/ServerSettingsOverlay.vue';
import ServerOverlay from './overlays/ServerOverlay.vue';
import OperationalOverlay from './overlays/OperationalOverlay.vue';
import OperationalRewardsOverlay from './overlays/OperationalRewardsOverlay.vue';
import { CloseRequestedEvent, getCurrentWindow } from '@tauri-apps/api/window';
import ProfileOverlay from './overlays/ProfileOverlay.vue';
import { checkInstallerIfCloseAllowed } from './stores/installer.ts';
import RuntimeCompatibilityScreen from './screens/RuntimeCompatibilityScreen.vue';
import { useAppUpdater } from './stores/appUpdater.ts';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';
import { storeToRefs } from 'pinia';
import ArgonBonds from './screens/ArgonBonds.vue';
import BitcoinLocks from './screens/BitcoinLocks.vue';
import LeftBar from './navigation/LeftBar.vue';
import StableSwaps from './screens/StableSwaps.vue';
import BitcoinLoans from './screens/BitcoinLoans.vue';
import Dashboard from './screens/Dashboard.vue';
import WelcomeToTreasuryOverlay from './overlays/WelcomeToTreasuryOverlay.vue';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import UpgradeToOperationsOverlay from './overlays/UpgradeToOperationsOverlay.vue';
import UpgradeToTreasuryOverlay from './overlays/UpgradeToTreasuryOverlay.vue';

const controller = useCertificationController();
const config = getConfig();
const tour = useTour();
const bot = getBot();

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();
const { shouldShowCompatibilityScreen } = storeToRefs(runtimeCompatibility);

updater.start();
runtimeCompatibility.start();

const order = [TopTab.Dashboard, TopTab.Mining, TopTab.Vaulting];

function keydownHandler(event: KeyboardEvent) {
  // Check for CMD+Shift+[ (mining panel)
  const currentOrder = order.indexOf(controller.selectedTab ?? TopTab.Dashboard);
  if (event.metaKey && event.shiftKey && event.key === '[') {
    event.preventDefault();
    const left = (currentOrder - 1 + order.length) % order.length;
    controller.setTab(order[left]);
  }
  // Check for CMD+Shift+] (vaulting panel)
  else if (event.metaKey && event.shiftKey && event.key === ']') {
    event.preventDefault();
    const right = (currentOrder + 1) % order.length;
    controller.setTab(order[right]);
  }
}

function externalLinkHandler(event: MouseEvent) {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;

  const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor || !['http:', 'https:'].includes(new URL(anchor.href).protocol)) return;

  event.preventDefault();
  void tauriOpenUrl(anchor.href);
}

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onMounted(async () => {
  // Add keyboard shortcuts for panel switching
  document.addEventListener('keydown', keydownHandler);
  document.addEventListener('click', externalLinkHandler);

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
  document.removeEventListener('click', externalLinkHandler);
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});

createMenu();
</script>
