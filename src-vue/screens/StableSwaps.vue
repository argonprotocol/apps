<template>
  <div DashBox data-testid="StableSwapsScreen" class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
    <Dashboard v-else-if="config.hasActivatedStableSwaps" />
    <BlankSlate v-else />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BlankSlate from './stable-swaps-screen/BlankSlate.vue';
import Dashboard from './stable-swaps-screen/Dashboard.vue';
import { getConfig } from '../stores/config.ts';
import { useStableSwaps } from '../stores/stableSwaps.ts';

const config = getConfig();
const stableSwaps = useStableSwaps();
const isLoaded = Vue.ref(false);

Vue.onMounted(async () => {
  if (config.hasActivatedStableSwaps) {
    try {
      await stableSwaps.load();
    } catch {
      // Dashboard renders the store's marketError.
    }
  }
  isLoaded.value = true;
});
</script>
