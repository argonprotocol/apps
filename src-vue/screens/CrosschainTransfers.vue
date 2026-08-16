<!-- prettier-ignore -->
<template>
  <div data-testid="CrosschainTransfersScreen" class="h-full">
    <Dashboard v-if="accessState.hasAccess" />
    <div v-else class="flex h-full flex-col items-center justify-center">
      <div class="text-2xl font-bold text-slate-600/40 uppercase">Loading...</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TopTab } from '../interfaces/IConfig.ts';
import { getCrosschainAccessState } from '../lib/CrosschainTransferView.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getMyVault } from '../stores/vaults.ts';
import Dashboard from './crosschain-transfers-screen/Dashboard.vue';

const controller = useCertificationController();
const config = getConfig();
const myVault = getMyVault();
const accessState = Vue.computed(() =>
  getCrosschainAccessState({
    hasActivatedCrosschain: config.hasActivatedCrosschain,
    authorityCount: myVault.mintingAuthorities.data.authorities.length,
    councilSigner: myVault.globalCouncil.data.councilSigner,
  }),
);

Vue.onMounted(async () => {
  await myVault.load();
  if (!accessState.value.hasAccess) {
    controller.setTab(TopTab.Vaulting);
  }
});
</script>
