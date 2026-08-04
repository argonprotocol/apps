<!-- prettier-ignore -->
<template>
  <template v-if="shouldShowCompatibilityScreen">
    <RuntimeCompatibilityScreen />
    <SecuritySettingsOverlay />
  </template>
  <div v-else class="h-screen w-screen flex flex-col overflow-hidden cursor-default">
    <TopBar />
    <div
      v-if="controller.isLoaded && !controller.isImporting"
      class="flex min-h-0 grow flex-col overflow-hidden"
    >
      <div class="relative z-10">
        <AlertBars />
      </div>

      <div class="flex min-h-0 grow flex-row gap-x-2 overflow-scroll pt-2 pb-2 pl-2">
        <LeftBar />
        <main class="relative flex min-h-0 grow flex-col overflow-hidden">
          <div
            class="flex min-h-0 grow flex-col overflow-x-hidden overflow-y-auto"
            :class="
              controller.selectedTab === TopTab.ArgonBonds ||
              controller.selectedTab === TopTab.BitcoinLocks ||
              controller.selectedTab === TopTab.StableSwaps
                ? 'rounded border-[1px] border-slate-400/40 bg-white shadow-md'
                : ''
            "
          >
            <Home v-if="controller.selectedTab === TopTab.Home || controller.selectedTab === 'Dashboard' as TopTab" />
            <Network v-else-if="controller.selectedTab === TopTab.Network" />

            <ArgonBonds v-else-if="controller.selectedTab === TopTab.ArgonBonds" />
            <ArgonotStakes v-else-if="controller.selectedTab === TopTab.ArgonotStaking" />
            <BitcoinLocks v-else-if="controller.selectedTab === TopTab.BitcoinLocks" />
            <StableSwaps v-else-if="controller.selectedTab === TopTab.StableSwaps" />

            <Mining v-else-if="controller.selectedTab === TopTab.Mining" />
            <Vaulting v-else-if="controller.selectedTab === TopTab.Vaulting" />
            <Onboarding
              v-else-if="controller.selectedTab === TopTab.Onboarding || controller.selectedTab === 'Invites' as TopTab"
            />
            <Home v-else />
          </div>
        </main>
      </div>
    </div>
    <div v-else class="grow relative">
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </div>
    <template v-if="config.isLoaded">
      <BootingOverlay v-if="config.isBootingUpPreviousWalletHistory && !bot.isSyncing" />
      <ServerConnectPanel />
      <WalletDialogs />
      <WalletDisconnectOverlay />
      <TransactionsOverlay />
      <SecuritizationOverlay />
      <BackfillOverlay />
      <TreasuryBondsOverlay />
      <ArgonotCommitmentOverlay />
      <MintingAuthorityRequestOverlay />
      <GatewayRelayOverlay />
      <ServerSettingsOverlay />
      <ServerRemoveOverlay />
      <CertificationOverlay />
      <OperationalRewardsOverlay />
      <MemberInviteOverlay />
      <SecuritySettingsOverlay />
      <ImportAccountOverlay />
      <BotEditOverlay />
      <SponsorOverlay />
      <!-- <ProvisioningCompleteOverlay /> -->
      <AboutOverlay />
      <SoftwareInfoOverlay />
      <OperationalProfileOverlay />
      <JurisdictionOverlay />
      <ServerOverlay />
      <TroubleshootingToolsOverlayOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <template v-else-if="config.showWelcomeOverlay">
        <WelcomeOverlay />
        <WelcomeToTreasuryOverlay />
      </template>
      <UpgradeToOperationsOverlay />
      <WelcomeToOperationsOverlay />
      <UpgradeToTreasuryOverlay />
      <BitcoinLockingOverlay />
      <BondPurchaseOverlay />
      <StakePurchaseOverlay />
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
import WalletDisconnectOverlay from './overlays/WalletDisconnectOverlay.vue';
import TransactionsOverlay from './overlays/TransactionsOverlay.vue';
import ServerRemoveOverlay from './overlays/ServerRemoveOverlay.vue';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
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
import TroubleshootingToolsOverlayOverlay from './overlays/TroubleshootingToolsOverlay.vue';
import BootingOverlay from './overlays/BootingOverlay.vue';
import WelcomeOverlay from './overlays/WelcomeOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import AlertBars from './navigation/AlertBars.vue';
import WelcomeTour from './overlays/WelcomeTour.vue';
import BotEditOverlay from './overlays/BotEditOverlay.vue';
import SecuritizationOverlay from './overlays/SecuritizationOverlay.vue';
import BackfillOverlay from './overlays/BackfillOverlay.vue';
import TreasuryBondsOverlay from './overlays/TreasuryBondsOverlay.vue';
import ArgonotCommitmentOverlay from './overlays/ArgonotCommitmentOverlay.vue';
import MintingAuthorityRequestOverlay from './overlays/MintingAuthorityRequestOverlay.vue';
import GatewayRelayOverlay from './overlays/GatewayRelayOverlay.vue';
import ServerSettingsOverlay from './overlays/ServerSettingsOverlay.vue';
import ServerOverlay from './overlays/ServerOverlay.vue';
import CertificationOverlay from './overlays/CertificationOverlay.vue';
import OperationalRewardsOverlay from './overlays/OperationalRewardsOverlay.vue';
import MemberInviteOverlay from './overlays/MemberInviteOverlay.vue';
import { CloseRequestedEvent, getCurrentWindow } from '@tauri-apps/api/window';
import OperationalProfileOverlay from './overlays/OperationalProfileOverlay.vue';
import { checkInstallerIfCloseAllowed } from './stores/installer.ts';
import RuntimeCompatibilityScreen from './screens/RuntimeCompatibilityScreen.vue';
import { useAppUpdater } from './stores/appUpdater.ts';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';
import { storeToRefs } from 'pinia';
import ArgonBonds from './screens/ArgonBonds.vue';
import BitcoinLocks from './screens/BitcoinLocks.vue';
import LeftBar from './navigation/LeftBar.vue';
import StableSwaps from './screens/StableSwaps.vue';
import Home from './screens/Home.vue';
import WelcomeToTreasuryOverlay from './overlays/WelcomeToTreasuryOverlay.vue';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import UpgradeToOperationsOverlay from './overlays/UpgradeToOperationsOverlay.vue';
import WelcomeToOperationsOverlay from './overlays/WelcomeToOperationsOverlay.vue';
import UpgradeToTreasuryOverlay from './overlays/UpgradeToTreasuryOverlay.vue';
import Onboarding from './screens/Onboarding.vue';
import ArgonotStakes from './screens/ArgonotStakes.vue';
import BitcoinLockingOverlay from './overlays/BitcoinLockingOverlay.vue';
import BondPurchaseOverlay from './overlays/BondPurchaseOverlay.vue';
import StakePurchaseOverlay from './overlays/StakePurchaseOverlay.vue';
import SponsorOverlay from './overlays/SponsorOverlay.vue';
import { getMainchainClients } from './stores/mainchain.ts';

const controller = useCertificationController();
const config = getConfig();
const tour = useTour();
const bot = getBot();

const updater = useAppUpdater();
const runtimeCompatibility = useRuntimeCompatibility();
const { shouldShowCompatibilityScreen } = storeToRefs(runtimeCompatibility);

updater.start();
runtimeCompatibility.start();

const order = [TopTab.Home, TopTab.Mining, TopTab.Vaulting];

function keydownHandler(event: KeyboardEvent) {
  // Check for CMD+Shift+[ (mining panel)
  const currentOrder = order.indexOf(controller.selectedTab ?? TopTab.Home);
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

function disposeAppTransports() {
  bot.dispose();
  void getMainchainClients().disconnect();
}

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onMounted(async () => {
  // Add keyboard shortcuts for panel switching
  document.addEventListener('keydown', keydownHandler);
  document.addEventListener('click', externalLinkHandler);
  window.addEventListener('beforeunload', disposeAppTransports);

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
  window.removeEventListener('beforeunload', disposeAppTransports);
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});

createMenu();
</script>
