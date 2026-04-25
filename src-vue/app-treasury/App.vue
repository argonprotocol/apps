<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden cursor-default gap-y-2">
    <TopBar />
    <div v-if="controller.isLoaded && !controller.isImporting" class="flex flex-row grow gap-x-2 px-2 pb-2">
      <LeftBar />
      <main DashBox class="flex flex-col grow relative h-full overflow-scroll">
        <ArgonSavings v-if="controller.selectedTab === TreasuryTab.MainchainSavings" />
        <ArgonBondsScreen v-if="controller.selectedTab === TreasuryTab.ArgonBonds" />
        <BitcoinLocksScreen v-if="controller.selectedTab === TreasuryTab.BitcoinLocks" />
        <P2PSavingsScreen v-if="controller.selectedTab === TreasuryTab.P2pSavings" />
        <P2PTaxesScreen v-if="controller.selectedTab === TreasuryTab.P2pTaxes" />
        <StableSwapsScreen v-if="controller.selectedTab === TreasuryTab.EthereumSwaps" />
      </main>
    </div>
    <div v-else class="grow relative">
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </div>
    <template v-if="config.isLoaded">
      <BootingOverlay v-if="config.isBootingUpPreviousWalletHistory" />
      <SecuritySettingsOverlay />
      <ImportAccountOverlay />
      <AboutOverlay />
      <VaultsOverlay />
      <JurisdictionOverlay />
      <WelcomeOverlay v-if="config.showWelcomeOverlay" />
    </template>
    <TroubleshootingOverlay />
    <AppUpdatesOverlay />
  </div>
</template>

<script setup lang="ts">
import '../lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './NativeMenu.ts';
import SecuritySettingsOverlay from '../app-operations/overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from '../app-operations/overlays/ImportAccountOverlay.vue';
import { getConfig } from '../stores/config.ts';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from '../app-shared/overlays/AboutOverlay.vue';
import JurisdictionOverlay from '../app-shared/overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from '../app-shared/overlays/Troubleshooting.vue';
import AppUpdatesOverlay from '../app-operations/overlays/AppUpdatesOverlay.vue';
import WelcomeOverlay from '../app-shared/overlays/WelcomeOverlay.vue';
import BootingOverlay from '../app-shared/overlays/BootingOverlay.vue';
import LeftBar from './navigation/LeftBar.vue';
import TopBar from './navigation/TopBar.vue';
import ArgonSavings from './screens/ArgonSavings.vue';
import P2PSavingsScreen from './screens/P2pSavingsScreen.vue';
import P2PTaxesScreen from './screens/P2pTaxesScreen.vue';
import BitcoinLocksScreen from './screens/BitcoinLocks.vue';
import ArgonBondsScreen from './screens/ArgonBonds.vue';
import StableSwapsScreen from './screens/StableSwaps.vue';
import { TreasuryTab, useTreasuryController } from '../stores/treasuryController.ts';
import VaultsOverlay from './overlays/VaultsOverlay.vue';

const controller = useTreasuryController();
const config = getConfig();

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});

createMenu();
</script>
