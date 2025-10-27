<!-- prettier-ignore -->
<template>
  <template v-if="myVault.data.isReady">
    <Dashboard v-if="config.isVaultActivated" />
    <BlankSlate v-else-if="!config.isPreparingVaultSetup && !config.hasSavedVaultingRules" />
    <FinalSetupChecklist v-else-if="!config.isVaultReadyToCreate" />
    <VaultIsInstalling v-else-if="config.isVaultReadyToCreate" />
  </template>
  <template v-else>
    <div class="flex flex-col items-center justify-center h-full">
      <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
    </div>
  </template>
</template>

<script setup lang="ts">
import BlankSlate from './vaulting-panel/BlankSlate.vue';
import FinalSetupChecklist from './vaulting-panel/FinalSetupChecklist.vue';
import { useConfig } from '../stores/config';
import VaultIsInstalling from './vaulting-panel/VaultIsInstalling.vue';
import { useMyVault } from '../stores/vaults.ts';
import Dashboard from './vaulting-panel/Dashboard.vue';
import { onMounted } from 'vue';

const myVault = useMyVault();
const config = useConfig();

onMounted(async () => {
  await myVault.load();
});
</script>
