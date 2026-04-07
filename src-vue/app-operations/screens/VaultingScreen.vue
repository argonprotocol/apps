<!-- prettier-ignore -->
<template>
  <div data-testid="VaultingScreen" class="h-full">
    <template v-if="myVault.data.isReady">
      <BlankSlate v-if="config.vaultingSetupStatus === VaultingSetupStatus.None" />
      <SetupChecklist v-else-if="config.vaultingSetupStatus === VaultingSetupStatus.Checklist" />
      <SetupInstalling v-else-if="config.vaultingSetupStatus === VaultingSetupStatus.Installing" />
      <Dashboard v-else-if="config.vaultingSetupStatus === VaultingSetupStatus.Finished" />
    </template>
    <template v-else>
      <div class="flex flex-col items-center justify-center h-full">
        <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import BlankSlate from './vaulting-screen/BlankSlate.vue';
import SetupChecklist from './vaulting-screen/SetupChecklist.vue';
import { getConfig } from '../../stores/config.ts';
import SetupInstalling from './vaulting-screen/SetupInstalling.vue';
import { getMyVault } from '../../stores/vaults.ts';
import Dashboard from './vaulting-screen/Dashboard.vue';
import { onMounted } from 'vue';
import { VaultingSetupStatus } from '../../interfaces/IConfig.ts';

const myVault = getMyVault();
const config = getConfig();

onMounted(async () => {
  await myVault.load();
});
</script>
