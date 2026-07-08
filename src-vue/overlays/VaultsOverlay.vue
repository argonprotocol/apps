<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="flex grow flex-row items-center justify-between gap-x-3 pr-4">
        <DialogTitle>Active Vaults</DialogTitle>
        <div class="text-sm font-normal text-slate-500">
          {{ financials.vaultsActiveRecords.length }} active
        </div>
      </div>
    </template>

    <div class="px-5 py-4">
      <p v-if="financials.vaultsActiveRecords.length" class="text-sm leading-6 font-light text-slate-600">
        Browse active network vaults and compare their current locking fees, revenue, and available securitization.
      </p>

      <SelectAVault @select="selectedVault" />

      <div class="flex flex-row justify-end gap-3 pt-3 px-3 mt-4 mb-3 border-t border-slate-300">
        <button
          type="button"
          class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          @click="closeOverlay"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!tmpVault"
          class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          @click="saveVault"
        >
          Save
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import SelectAVault from '../components/SelectAVault.vue';
import { useBasics } from '../stores/basics.ts';
import { getConfig } from '../stores/config.ts';
import { Vault } from '@argonprotocol/mainchain';
import { useFinancials } from '../stores/financials.ts';

const basics = useBasics();
const financials = useFinancials();
const config = getConfig();

const isOpen = Vue.ref(false);
const tmpVault = Vue.ref<Vault>();

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
  tmpVault.value = undefined;
}

function selectedVault(vault: Vault) {
  tmpVault.value = vault;
}

async function saveVault() {
  const vault = tmpVault.value;
  if (!vault) return;

  config.upstreamOperator = {
    name: vault.name ?? '',
    vaultId: vault.vaultId,
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
