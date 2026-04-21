<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="flex grow flex-row items-center justify-between gap-x-3 pr-4">
        <DialogTitle>Active Vaults</DialogTitle>
        <div class="text-sm font-normal text-slate-500">
          {{ vaultRows.length }} active
        </div>
      </div>
    </template>

    <div class="px-5 py-4">
      <p v-if="vaultRows.length > 0" class="text-sm leading-6 font-light text-slate-600">
        Browse active network vaults and compare their current locking fees, revenue, and available securitization.
      </p>

      <SelectAVault @load="loadedVaults" @select="selectedVault" />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import SelectAVault from '../../components/SelectAVault.vue';
import { useBasics } from '../../stores/basics.ts';
import { getConfig } from '../../stores/config.ts';
import { Vault } from '@argonprotocol/mainchain';

const basics = useBasics();
const config = getConfig();

const isOpen = Vue.ref(false);
const vaultRows = Vue.shallowRef<Vault[]>([]);

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function loadedVaults(rows: Vault[]) {
  vaultRows.value = rows;
}

async function selectedVault(vault: Vault) {
  config.upstreamOperator = {
    name: vault.name ?? '',
    vaultId: vault.vaultId,
    inviteSecret: config.upstreamOperator?.inviteSecret,
    accountId: config.upstreamOperator?.accountId,
  };
  await config.save();
  closeOverlay();
}

basicEmitter.on('openVaultsOverlay', async () => {
  isOpen.value = true;
  basics.overlayIsOpen = true;
});
</script>
