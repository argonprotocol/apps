<template>
  <div DashBox data-testid="BitcoinScreen" class="flex grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
    <Dashboard v-else-if="hasBitcoinRecords" />
    <BlankSlate v-else />
    <BitcoinLiquidCreationController />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BitcoinLiquidCreationController from '../overlays/BitcoinLiquidCreationController.vue';
import BlankSlate from './bitcoin-screen/BlankSlate.vue';
import Dashboard from './bitcoin-screen/Dashboard.vue';
import { getBitcoinFissions, getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import { useFinancials } from '../stores/financials.ts';

const bitcoinLocks = getBitcoinLocks();
const bitcoinFissions = getBitcoinFissions();
const currency = getCurrency();
const financials = useFinancials();
const isLoaded = Vue.ref(false);
const hasBitcoinRecords = Vue.computed(
  () =>
    financials.bitcoinLockDisplayRecords.length > 0 ||
    financials.liquidInvisibleRecords.length > 0 ||
    bitcoinFissions.getAll().length > 0 ||
    bitcoinLocks.utxoTracking.getAllOrphanLifecycleUtxos().length > 0,
);

Vue.onMounted(async () => {
  await Promise.all([currency.isLoadedPromise, bitcoinLocks.load(), bitcoinFissions.load()]);
  isLoaded.value = true;
});
</script>
