<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-row overflow-hidden cursor-default rounded-2xl">
    <LeftBar />
    <main v-if="controller.isLoaded && !controller.isImporting" class="flex flex-col grow relative h-full overflow-scroll">
      <TopBar />
      <MainchainScreen v-if="controller.selectedTab === CapitalTab.Mainchain" />
      <LocalchainScreen v-if="controller.selectedTab === CapitalTab.Localchain" />
      <EthereumScreen v-if="controller.selectedTab === CapitalTab.Ethereum" />
      <ArgonBondsScreen v-if="controller.selectedTab === CapitalTab.ArgonBonds" />
      <BitcoinLocksScreen v-if="controller.selectedTab === CapitalTab.BitcoinLocks" />
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
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './CapitalAppMenu.ts';
import SecuritySettingsOverlay from './overlays-operations/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays-operations/ImportAccountOverlay.vue';
import { getConfig } from './stores/config';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from './overlays-shared/AboutOverlay.vue';
import JurisdictionOverlay from './overlays-shared/JurisdictionOverlay.vue';
import TroubleshootingOverlay from './overlays-shared/Troubleshooting.vue';
import ImportingAccountOverlay from './overlays-operations/ImportingAccountOverlay.vue';
import AppUpdatesOverlay from './overlays-operations/AppUpdatesOverlay.vue';
import WelcomeOverlay from './overlays-operations/WelcomeOverlay.vue';
import BootingOverlay from './overlays-shared/BootingOverlay.vue';
import LeftBar from './navigation-capital/LeftBar.vue';
import TopBar from './navigation-capital/TopBar.vue';
import MainchainScreen from './screens-capital/MainchainScreen.vue';
import LocalchainScreen from './screens-capital/LocalchainScreen.vue';
import EthereumScreen from './screens-capital/EthereumScreen.vue';
import BitcoinLocksScreen from './screens-capital/BitcoinLocks.vue';
import ArgonBondsScreen from './screens-capital/ArgonBonds.vue';
import { CapitalTab, useCapitalController } from './stores/capitalController.ts';

const controller = useCapitalController();
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
