<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @pressEsc="emit('close')" class="w-240">
    <template #title>
      <div v-if="!vaultId" class="grow text-2xl font-bold">Select Vault for Bond Buying</div>
      <div v-else class="grow text-2xl font-bold">Buy Bonds</div>
    </template>

    <div v-if="!vaultId" class="px-6 pt-2 pb-7">
      <SelectAVault v-if="!vaultId" unitType="ArgonBond" @select="handleVaultSelected" />
      <div class="flex flex-row justify-end gap-3 pt-3 px-3 mt-4 mb-3 border-t border-slate-300">
        <button
          type="button"
          class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!tmpVaultId"
          class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          @click="selectVault"
        >
          Select Vault
        </button>
      </div>
    </div>
    <div v-else class="px-6 py-5">
      <BuyBondsForm
        :vaultId="vaultId"
        :walletBalance="wallets.investmentWallet.availableMicrogons"
        @close="emit('close')"
        @submitted="emit('submitted')"
      />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BuyBondsForm from '../../app-shared/overlays/BuyBondsForm.vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import SelectAVault from '../../components/SelectAVault.vue';
import { Vault } from '@argonprotocol/mainchain';
import { getConfig } from '../../stores/config.ts';
import { useWallets } from '../../stores/wallets.ts';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const config = getConfig();
const wallets = useWallets();

const tmpVaultId = Vue.ref();
const vaultId = Vue.ref(config.upstreamOperator?.vaultId);

function handleVaultSelected(v: Vault) {
  tmpVaultId.value = v.vaultId;
}

function selectVault() {
  vaultId.value = tmpVaultId.value;
}
</script>
