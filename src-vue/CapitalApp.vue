<!-- prettier-ignore -->
<template>
  <div class="h-screen w-screen flex flex-row overflow-hidden cursor-default rounded-2xl">
    <LeftBar />
    <main v-if="controller.isLoaded && !controller.isImporting" class="flex flex-col grow relative h-full overflow-scroll">
      <TopBar />
      <MainScreen />
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
    <ImportingOverlay />
    <AppUpdatesOverlay />
  </div>
</template>

<script setup lang="ts">
import './lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { createMenu } from './CapitalAppMenu.ts';
import SecuritySettingsOverlay from './overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from './overlays/ImportAccountOverlay.vue';
import { useController } from './stores/controller';
import { getConfig } from './stores/config';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from './overlays/AboutOverlay.vue';
import JurisdictionOverlay from './overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from './overlays/Troubleshooting.vue';
import ImportingOverlay from './overlays/ImportingOverlay.vue';
import AppUpdatesOverlay from './overlays/AppUpdatesOverlay.vue';
import WelcomeOverlay from './overlays/WelcomeOverlay.vue';
import MainScreen from './screens-capital/MainScreen.vue';
import BootingOverlay from './overlays/BootingOverlay.vue';
import LeftBar from './navigation-capital/LeftBar.vue';
import TopBar from './navigation-capital/TopBar.vue';

const controller = useController();
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
