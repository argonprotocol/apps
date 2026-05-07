<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @pressEsc="emit('close')" class="w-5/12">
    <template #title>
      <div v-if="!vaultId" class="grow text-2xl font-bold">Select Vault</div>
      <div v-else class="grow text-2xl font-bold">Buy Bonds</div>
    </template>

    <SelectAVault v-if="!vaultId" @select="handleVaultSelected" />
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

const config = getConfig();
const wallets = useWallets();

const props = defineProps<{}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const vaultId = Vue.ref(config.upstreamOperator?.vaultId);

function handleVaultSelected(v: Vault) {
  vaultId.value = v.vaultId;
}
</script>
