<template>
  <TwoSlicePie
    :data="data"
    :rotation="rotation"
    :animate="props.shouldAnimateChart"
    :strokeWidth="props.strokeWidth"
    :borderWidth="props.borderWidth"
    class="absolute -top-[15px] left-1/2 flex h-[calc(110%+30px)]! w-[calc(100%+30px)] -translate-x-1/2 flex-row justify-center"
  />
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import TwoSlicePie from '../../../components/TwoSlicePie.vue';
import BigNumber from 'bignumber.js';
import { useWallets } from '../../../stores/wallets.ts';

const wallets = useWallets();

const props = defineProps<{
  shouldAnimateChart?: boolean;
  borderWidth?: number;
  strokeWidth?: number;
}>();

const miningPct = Vue.computed(() => {
  if (!wallets.totalOperationalResources) return 0;
  return BigNumber(wallets.totalMiningResources).div(wallets.totalOperationalResources).toNumber() * 100;
});

const vaultingPct = Vue.computed(() => {
  if (!wallets.totalOperationalResources) return 0;
  return BigNumber(wallets.totalVaultingResources).div(wallets.totalOperationalResources).toNumber() * 100;
});

const data = Vue.computed<[any, any]>(() => [
  { label: 'Mining', value: miningPct.value || 0.1, color: '#DF8DDC' },
  { label: 'Vaulting', value: vaultingPct.value || 0.1, color: '#CFCBF6' },
]);

const rotation = Vue.computed(() => {
  if (!vaultingPct.value && !miningPct.value) {
    return 0;
  } else if (vaultingPct.value >= 84) {
    const diff = 16 - (100 - vaultingPct.value);
    return -(diff * 2);
  } else if (vaultingPct.value >= 16) {
    return 0;
  }
  return 32 - vaultingPct.value * 1.6;
});
</script>
