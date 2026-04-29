<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-lg">
    <template #title>
      <div class="text-2xl font-bold grow">Move Your {{ walletTypeName[walletType!] }} Funds</div>
    </template>
    <div class="px-6 py-4 text-sm font-medium text-gray-700">
      <MoveCapitalCore
        :isOpen="isOpen"
        :showInputMenus="true"
        :walletType="walletType"
        :moveTo="moveTo"
        :maxAmount="maxAmount"
        @close="closeOverlay"
      />
    </div>
  </OverlayBase>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import MoveCapitalCore from './move-capital/MoveCapitalCore.vue';
import { WalletType } from '../../lib/Wallet.ts';
import { MoveTo } from '@argonprotocol/apps-core';

const isOpen = Vue.ref(false);
const walletType = Vue.ref<WalletType.miningHold | WalletType.vaulting>();
const moveTo = Vue.ref<MoveTo | undefined>();
const maxAmount = Vue.ref<bigint | undefined>();

const walletTypeName = {
  [WalletType.miningHold]: 'Mining',
  [WalletType.vaulting]: 'Vaulting',
};

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openMoveCapitalOverlay', async data => {
  isOpen.value = true;
  walletType.value = data.walletType;
  moveTo.value = data.moveTo;
  maxAmount.value = data.maxAmount;
});
</script>
