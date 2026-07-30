<template>
  <div DashBox data-testid="BitcoinLocksScreen" class="flex grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
    <Dashboard v-else-if="hasBitcoinRecords" />
    <BlankSlate
      v-else
      :is-restoring-history="financials.isHistoryRecoveryInProgress"
      :active-bitcoin-lock-count="financials.activeBitcoinLockCount"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BlankSlate from './bitcoin-locks-screen/BlankSlate.vue';
import Dashboard from './bitcoin-locks-screen/Dashboard.vue';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { useFinancials } from '../stores/financials.ts';

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const financials = useFinancials();
const isLoaded = Vue.ref(false);
const hasBitcoinRecords = Vue.computed(
  () => financials.bitcoinLockDisplayRecords.length > 0 || financials.liquidInvisibleRecords.length > 0,
);

Vue.onMounted(async () => {
  await Promise.all([currency.isLoadedPromise, bitcoinLocks.load()]);
  isLoaded.value = true;
});
</script>
