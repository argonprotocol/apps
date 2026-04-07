<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-row overflow-hidden cursor-default rounded-2xl">
    <LeftBar />
    <main v-if="controller.isLoaded && !controller.isImporting" class="flex flex-col grow relative h-full overflow-scroll">
      <TopBar />
      <MainchainScreen v-if="controller.selectedTab === TreasuryTab.Mainchain" />
      <LocalchainScreen v-if="controller.selectedTab === TreasuryTab.Localchain" />
      <EthereumScreen v-if="controller.selectedTab === TreasuryTab.Ethereum" />
      <ArgonBondsScreen v-if="controller.selectedTab === TreasuryTab.ArgonBonds" />
      <BitcoinLocksScreen v-if="controller.selectedTab === TreasuryTab.BitcoinLocks" />
      <StableSwapsScreen v-if="controller.selectedTab === TreasuryTab.StableSwaps" />
    </main>
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
      <JurisdictionOverlay />
      <WelcomeOverlay v-if="config.showWelcomeOverlay" />
    </template>
    <TroubleshootingOverlay />
    <ImportingAccountOverlay />
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
import ImportingAccountOverlay from '../app-operations/overlays/ImportingAccountOverlay.vue';
import AppUpdatesOverlay from '../app-operations/overlays/AppUpdatesOverlay.vue';
import WelcomeOverlay from '../app-operations/overlays/WelcomeOverlay.vue';
import BootingOverlay from '../app-shared/overlays/BootingOverlay.vue';
import LeftBar from './navigation/LeftBar.vue';
import TopBar from './navigation/TopBar.vue';
import MainchainScreen from './screens/MainchainScreen.vue';
import LocalchainScreen from './screens/LocalchainScreen.vue';
import EthereumScreen from './screens/EthereumScreen.vue';
import BitcoinLocksScreen from './screens/BitcoinLocks.vue';
import ArgonBondsScreen from './screens/ArgonBonds.vue';
import StableSwapsScreen from './screens/StableSwaps.vue';
import { TreasuryTab, useTreasuryController } from '../stores/treasuryController.ts';

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
