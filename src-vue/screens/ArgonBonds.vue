<template>
  <div DashBox data-testid="ArgonBondsScreen" class="flex grow flex-col">
    <div v-if="loadError" class="flex grow flex-col items-center justify-center px-6 text-center">
      <p class="text-lg font-semibold text-slate-700">Unable to load Argon bonds</p>
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
    <Dashboard v-else-if="bondLots.length" />
    <BlankSlate v-else />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BlankSlate from './argon-bonds-screen/BlankSlate.vue';
import Dashboard from './argon-bonds-screen/Dashboard.vue';
import { getArgonBonds } from '../stores/argonBonds.ts';

const argonBonds = getArgonBonds();
const isLoaded = Vue.computed(() => argonBonds.data.isLoaded);
const bondLots = Vue.computed(() => argonBonds.data.bondLots.filter(bondLot => bondLot.programType === 'Vault'));
const loadError = Vue.ref('');

async function loadArgonBonds() {
  loadError.value = '';
  try {
    await argonBonds.load();
  } catch (error) {
    console.error('[ArgonBondsScreen] Unable to load Argon bonds', error);
    loadError.value = error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.';
  }
}

Vue.onMounted(loadArgonBonds);
</script>
