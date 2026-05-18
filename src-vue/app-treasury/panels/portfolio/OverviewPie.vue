<template>
  <FourSlicePie
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
import FourSlicePie, { ISlice } from '../../../components/FourSlicePie.vue';
import BigNumber from 'bignumber.js';
import { useWallets } from '../../../stores/wallets.ts';
import { useFinancials } from '../../stores/financials.ts';
import { getCurrency } from '../../../stores/currency.ts';

const wallets = useWallets();
const currency = getCurrency();
const financials = useFinancials();

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

function toSliceValue(value: bigint): number {
  return value > 0n ? BigNumber(value.toString()).toNumber() : 0.1;
}

const data = Vue.computed<[ISlice, ISlice, ISlice, ISlice]>(() => [
  { label: 'Savings', value: toSliceValue(financials.savingsTotalValue), color: '#9FE1CB' },
  {
    label: 'Locks',
    value: toSliceValue(currency.convertSatToMicrogon(financials.liquidTotalSatoshis)),
    color: '#FAC775',
  },
  { label: 'Bonds', value: toSliceValue(financials.bondsTotalValue), color: '#CFCBF6' },
  { label: 'Swaps', value: toSliceValue(financials.swapsTotalValue), color: '#D3D1C7' },
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
