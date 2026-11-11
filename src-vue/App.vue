<!-- prettier-ignore -->
<template>
  <AppBootstrap v-if="!isAppReady" @open-account="openAccount" />
  <div v-else class="h-screen w-screen flex flex-col overflow-hidden cursor-default">
    <TopBar v-if="startup.startup?.isReady" />
    <div
      v-if="startup.startup?.isReady && controller.isLoaded && !startup.isImporting"
      class="flex min-h-0 grow flex-col overflow-hidden"
    >
      <div class="relative">
        <AlertBars />
      </div>

      <div class="flex min-h-0 grow flex-row gap-x-2 overflow-scroll p-2">
        <LeftBar :hasStabilizerOpportunity="!!attention?.stabilizerBuyOpportunity" />
        <main class="relative flex min-h-0 grow flex-col overflow-hidden">
          <div class="flex min-h-0 grow flex-col overflow-x-hidden overflow-y-auto">
            <Home v-if="controller.selectedTab === TopTab.Home || controller.selectedTab === 'Dashboard' as TopTab" />
            <Network v-else-if="controller.selectedTab === TopTab.Network" />
            <MarketStabilizers v-else-if="controller.selectedTab === TopTab.MarketStabilizers" />

            <ArgonBonds v-else-if="controller.selectedTab === TopTab.ArgonBonds" />
            <ArgonotStakes v-else-if="controller.selectedTab === TopTab.ArgonotStaking" />
            <Bitcoin v-else-if="controller.selectedTab === TopTab.BitcoinLocks" />

            <Mining v-else-if="controller.selectedTab === TopTab.Mining" />
            <Vaulting v-else-if="controller.selectedTab === TopTab.Vaulting" />
            <CrosschainTransfers v-else-if="controller.selectedTab === TopTab.CrosschainTransfers" />
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
    <template v-if="startup.startup?.isReady">
      <BootingOverlay v-if="startup.startup?.isRecoveringHistory && !startup.bot?.isSyncing" />
      <ServerConnectPanel />
      <WalletOverlay />
      <ConnectorDisconnectOverlay />
      <TransactionsOverlay />
      <CrosschainHistoryOverlay />
      <VaultSettingsPanel />
      <FlexibleAssetsOverlay />
      <MintingAuthorityRequestOverlay />
      <GatewayRelayOverlay />
      <ServerSettingsOverlay />
      <ServerRemoveOverlay />
      <CertificationOverlay />
      <OperationalRewardsOverlay />
      <MemberInviteOverlay />
      <MemberDetailsOverlay />
      <ImportAccountOverlay />
      <BotEditOverlay />
      <SponsorOverlay />
      <!-- <ProvisioningCompleteOverlay /> -->
      <OperationalProfileOverlay />
      <DiscordVerificationOverlay />
      <JurisdictionOverlay />
      <ServerOverlay />
      <WelcomeTour v-if="tour.currentStep" />
      <template v-else-if="config.showWelcomeOverlay">
        <WelcomeOverlay />
        <WelcomeToTreasuryOverlay />
      </template>
      <UpgradeToOperationsOverlay />
      <WelcomeToOperationsOverlay />
      <UpgradeToTreasuryOverlay />
      <BondPurchaseOverlay />
      <StakePurchaseOverlay />
    </template>
  </div>

  <AboutOverlay />
  <SoftwareInfoOverlay />
  <TroubleshootingToolsOverlayOverlay :local-only="!isAppReady" />
  <AppUpdatesOverlay />
  <template v-if="!compatibility.isBrowserUnsupported">
    <AccountAuthenticationOverlay />
    <SecuritySettingsOverlay :mnemonic-only="!isAppReady" />
  </template>
</template>

<script setup lang="ts">
import { runtimeClient } from '@argonprotocol/runtime-client';
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import Network from './screens/Network.vue';
import MarketStabilizers from './screens/MarketStabilizers.vue';
import Mining from './screens/Mining.vue';
import Vaulting from './screens/Vaulting.vue';
import CrosschainTransfers from './screens/CrosschainTransfers.vue';
import ServerConnectPanel from './panels/ServerConnectPanel.vue';
import WalletOverlay from './wallets/WalletOverlay.vue';
import ConnectorDisconnectOverlay from './wallets/components/ConnectorDisconnectOverlay.vue';
import TransactionsOverlay from './overlays/TransactionsOverlay.vue';
import CrosschainHistoryOverlay from './overlays/CrosschainHistoryOverlay.vue';
import ServerRemoveOverlay from './overlays/ServerRemoveOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
import TopBar from './navigation/TopBar.vue';
import { TopTab } from './interfaces/IConfig.ts';
import { useCertificationController } from './stores/certificationController.ts';
import { getConfig } from './stores/config.ts';
import { useStartupStore } from './stores/startup.ts';
import { useTour } from './stores/tour.ts';
import AboutOverlay from './overlays/AboutOverlay.vue';
import SoftwareInfoOverlay from './overlays/SoftwareInfoOverlay.vue';
import JurisdictionOverlay from './overlays/JurisdictionOverlay.vue';
import TroubleshootingToolsOverlayOverlay from './overlays/TroubleshootingToolsOverlay.vue';
import BootingOverlay from './overlays/BootingOverlay.vue';
import WelcomeOverlay from './overlays/WelcomeOverlay.vue';
import AlertBars from './navigation/AlertBars.vue';
import WelcomeTour from './overlays/WelcomeTour.vue';
import BotEditOverlay from './overlays/BotEditOverlay.vue';
import VaultSettingsPanel from './panels/VaultSettingsPanel.vue';
import FlexibleAssetsOverlay from './overlays/FlexibleAssetsOverlay.vue';
import MintingAuthorityRequestOverlay from './overlays/MintingAuthorityRequestOverlay.vue';
import GatewayRelayOverlay from './overlays/GatewayRelayOverlay.vue';
import ServerSettingsOverlay from './overlays/ServerSettingsOverlay.vue';
import ServerOverlay from './overlays/ServerOverlay.vue';
import CertificationOverlay from './overlays/CertificationOverlay.vue';
import OperationalRewardsOverlay from './overlays/OperationalRewardsOverlay.vue';
import MemberInviteOverlay from './overlays/MemberInviteOverlay.vue';
import MemberDetailsOverlay from './overlays/MemberDetailsOverlay.vue';
import OperationalProfileOverlay from './overlays/OperationalProfileOverlay.vue';
import DiscordVerificationOverlay from './overlays/DiscordVerificationOverlay.vue';
import ArgonBonds from './screens/ArgonBonds.vue';
import Bitcoin from './screens/Bitcoin.vue';
import LeftBar from './navigation/LeftBar.vue';
import { useAttention, openStabilizerBuyNotice } from './stores/attention.ts';
import Home from './screens/Home.vue';
import WelcomeToTreasuryOverlay from './overlays/WelcomeToTreasuryOverlay.vue';
import UpgradeToOperationsOverlay from './overlays/UpgradeToOperationsOverlay.vue';
import WelcomeToOperationsOverlay from './overlays/WelcomeToOperationsOverlay.vue';
import UpgradeToTreasuryOverlay from './overlays/UpgradeToTreasuryOverlay.vue';
import Onboarding from './screens/Onboarding.vue';
import ArgonotStakes from './screens/ArgonotStakes.vue';
import BondPurchaseOverlay from './overlays/BondPurchaseOverlay.vue';
import StakePurchaseOverlay from './overlays/StakePurchaseOverlay.vue';
import SponsorOverlay from './overlays/SponsorOverlay.vue';
import { getBlockWatch, getMainchainClient } from './stores/mainchain.ts';
import { getMyVault } from './stores/vaults.ts';
import { getArgonBonds } from './stores/argonBonds.ts';

import AppBootstrap from './AppBootstrap.vue';
import AccountAuthenticationOverlay from './overlays/AccountAuthenticationOverlay.vue';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import { useRuntimeCompatibility } from './stores/runtimeCompatibility.ts';
import { createMenu } from './NativeMenu.ts';
import { getMainchainClients } from './stores/mainchain.ts';
import type { EncryptionAuthentication } from './lib/EncryptionSecret.ts';
import basicEmitter from './emitters/basicEmitter.ts';

let foregroundRefreshPromise: Promise<void> | undefined;
let lastForegroundFinalizedHash: string | undefined;

const startup = useStartupStore();
const attention = Vue.computed(() => (startup.isWalletReady ? useAttention() : undefined));
const compatibility = useRuntimeCompatibility();
const controller = Vue.computed(() => useCertificationController());
const config = Vue.computed(() => getConfig());
const tour = Vue.computed(() => useTour());

const isAppReady = Vue.computed(() => {
  if (compatibility.shouldShowCompatibilityScreen) return false;
  if (!startup.startup?.isReady) return false;
  return controller.value.isLoaded;
});

async function openAccount(authentication?: EncryptionAuthentication) {
  try {
    await startup.initialize(authentication);
  } catch {
    // Startup publishes the retryable error shown by AppBootstrap.
  }
}

Vue.onMounted(() => {
  basicEmitter.on('openStabilizerBuyNotice', openStabilizerBuyNotice);
  window.addEventListener('beforeunload', disposeTransports);
  window.addEventListener('focus', refreshFinalizedStateOnFocus);

  Vue.watch(
    () => startup.isWalletReady,
    ready => {
      if (ready) void createMenu();
    },
    { immediate: true },
  );
  Vue.watch(
    () => compatibility.shouldShowCompatibilityScreen,
    blocked => {
      if (!blocked && !startup.isWalletReady) void openAccount();
    },
    { immediate: true },
  );
});

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openStabilizerBuyNotice', openStabilizerBuyNotice);
  window.removeEventListener('beforeunload', disposeTransports);
  window.removeEventListener('focus', refreshFinalizedStateOnFocus);
});

function disposeTransports() {
  startup.bot?.dispose();
  if (startup.isWalletReady) void getMainchainClients().disconnect();
}

function refreshFinalizedStateOnFocus() {
  if (!isAppReady.value || foregroundRefreshPromise) return;

  foregroundRefreshPromise = (async () => {
    await getBlockWatch()
      .refreshAfterResume()
      .catch(error => console.error('[App] Unable to repair block subscriptions after window focus', error));

    const archiveClient = await getMainchainClient(true);
    const finalizedHash = await archiveClient.rpc.chain.getFinalizedHead();
    const blockHash = finalizedHash.toHex();
    if (blockHash === lastForegroundFinalizedHash) return;

    const finalizedClient = runtimeClient(await archiveClient.raw.at(finalizedHash));
    const nextFrameId = await finalizedClient.query.miningSlot.nextFrameId();
    if (nextFrameId === null) return;
    const currentFrameId = nextFrameId - 1;
    const myVault = getMyVault();
    const argonBonds = getArgonBonds();

    await Promise.all([
      myVault.refreshFinalizedState({ client: finalizedClient, currentFrameId }),
      argonBonds.refreshActiveState(),
    ]);
    lastForegroundFinalizedHash = blockHash;
  })()
    .catch(error => console.error('[App] Unable to refresh finalized state after window focus', error))
    .finally(() => {
      foregroundRefreshPromise = undefined;
    });
}
</script>
