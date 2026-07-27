<template>
  <div DashBox data-testid="ArgonotStakesScreen" class="flex h-full min-h-0 grow flex-col">
    <div v-if="loadError" class="flex grow flex-col items-center justify-center px-6 text-center">
      <p class="text-lg font-semibold text-slate-700">Unable to load Argonot stakes</p>
      <p class="mt-2 max-w-xl text-sm text-rose-700/80">{{ loadError }}</p>
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover mt-6 cursor-pointer rounded-md px-6 py-2 font-semibold text-white"
        @click="loadArgonBonds"
      >
        Retry
      </button>
    </div>
    <div v-else-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
    <Dashboard v-else-if="stakeLots.length" />
    <BlankSlate v-else />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BlankSlate from './argonot-stakes-screen/BlankSlate.vue';
import Dashboard from './argonot-stakes-screen/Dashboard.vue';
import { getArgonBonds } from '../stores/argonBonds.ts';

const argonBonds = getArgonBonds();
const isLoaded = Vue.computed(() => argonBonds.data.isLoaded);
const stakeLots = Vue.computed(() => argonBonds.data.bondLots.filter(bondLot => bondLot.programType === 'Argonot'));
const loadError = Vue.ref('');

async function loadArgonBonds() {
  loadError.value = '';
  try {
    await argonBonds.load();
  } catch (error) {
    console.error('[ArgonotStakesScreen] Unable to load Argonot stakes', error);
    loadError.value = error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.';
  }
}

Vue.onMounted(loadArgonBonds);
</script>
