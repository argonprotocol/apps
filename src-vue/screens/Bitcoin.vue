<template>
  <div DashBox data-testid="BitcoinScreen" class="flex grow flex-col">
    <Dashboard v-if="hasBitcoinRecords" />
    <div v-else-if="loadError" class="flex grow flex-col items-center justify-center text-slate-600">
      <div class="font-bold">Bitcoin could not be loaded.</div>
      <div class="mt-1 text-sm">{{ loadError.message }}</div>
      <button
        @click="retryLoad"
        :disabled="isRetrying"
        class="border-argon-button text-argon-button hover:border-argon-button-hover hover:text-argon-button-hover mt-4 cursor-pointer rounded border px-4 py-1 font-bold disabled:pointer-events-none disabled:opacity-50"
      >
        {{ isRetrying ? 'Retrying…' : 'Retry' }}
      </button>
    </div>
    <div v-else-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
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
const isRetrying = Vue.ref(false);
const isLoaded = Vue.computed(
  () => currency.isLoaded && bitcoinLocks.data.readiness === 'ready' && bitcoinFissions.data.readiness === 'ready',
);
const loadError = Vue.computed(() => bitcoinLocks.data.loadError ?? bitcoinFissions.data.loadError);
const hasBitcoinRecords = Vue.computed(
  () =>
    financials.bitcoinLockDisplayRecords.length > 0 ||
    financials.liquidInvisibleRecords.length > 0 ||
    bitcoinFissions.getAll().length > 0 ||
    bitcoinLocks.utxoTracking.getAllOrphanLifecycleUtxos().length > 0,
);

async function retryLoad(): Promise<void> {
  if (isRetrying.value) return;

  isRetrying.value = true;
  try {
    await Promise.all([bitcoinLocks.load(), bitcoinFissions.load()]);
  } catch {
    // The domain owners publish the retryable error used above.
  } finally {
    isRetrying.value = false;
  }
}
</script>
