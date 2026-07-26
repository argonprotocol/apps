<template>
  <BuyBondsOverlay
    v-if="programType"
    :programType="programType"
    @close="programType = undefined"
    @submitted="onSubmitted"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { BondLot } from '@argonprotocol/apps-core';
import BuyBondsOverlay from './BuyBondsOverlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getArgonBonds } from '../stores/argonBonds.ts';

const argonBonds = getArgonBonds();
const programType = Vue.ref<BondLot['programType']>();

function openOverlay(value: BondLot['programType']) {
  programType.value = value;
}

async function onSubmitted() {
  const submittedProgramType = programType.value;
  programType.value = undefined;
  await argonBonds.refreshBondLots();
  basicEmitter.emit('bondPurchaseSubmitted', submittedProgramType);
}

function closeOverlay() {
  programType.value = undefined;
}

Vue.onMounted(() => {
  basicEmitter.on('openBuyBondsOverlay', openOverlay);
  basicEmitter.on('closeAllOverlays', closeOverlay);
});
Vue.onUnmounted(() => {
  basicEmitter.off('openBuyBondsOverlay', openOverlay);
  basicEmitter.off('closeAllOverlays', closeOverlay);
});
</script>
