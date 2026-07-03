<!-- prettier-ignore -->
<template>
  <div class="h-full pt-2 w-screen flex flex-row overflow-hidden cursor-default gap-y-2">
    <div @click="">Operational Bonds</div>
    <div>Bitcoin Locks</div>
  </div>
</template>

<script setup lang="ts">
import '../lib/Env.ts'; // load env first
import * as Vue from 'vue';
import SecuritySettingsOverlay from '../overlays/SecuritySettingsOverlay.vue';
import ImportAccountOverlay from '../overlays/ImportAccountOverlay.vue';
import { getConfig } from '../stores/config.ts';
import { waitForLoad } from '@argonprotocol/mainchain';
import AboutOverlay from '../overlays/AboutOverlay.vue';
import JurisdictionOverlay from '../overlays/JurisdictionOverlay.vue';
import TroubleshootingOverlay from '../overlays/Troubleshooting.vue';
import AppUpdatesOverlay from '../overlays/AppUpdatesOverlay.vue';
import WelcomeOverlay from '../overlays/WelcomeOverlay.vue';
import BootingOverlay from '../overlays/BootingOverlay.vue';
import TreasuryLeftBar from '../navigation/TreasuryLeftBar.vue';
import InflationFreeSavings from './treasury/InflationFreeSavings.vue';
import TreasuryLocksScreenScreen from './TreasuryLocksScreen.vue';
import TreasuryBondsScreenScreen from './TreasuryBondsScreen.vue';
import StableSwapsScreen from './treasury/StableSwaps.vue';
import { TreasuryTab, useTreasuryController } from '../stores/treasuryController.ts';
import VaultsOverlay from '../overlays/VaultsOverlay.vue';
import InterestFreeLiabilities from './treasury/InterestFreeLiabilities.vue';
import TransactionsOverlay from '../overlays/TransactionsOverlay.vue';

const controller = useTreasuryController();
const config = getConfig();

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});
</script>
