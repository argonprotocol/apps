<template>
  <div DashBox data-testid="ArgonotStakesScreen" class="flex h-full min-h-0 grow flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading…</div>
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

Vue.onMounted(() => argonBonds.load());
</script>
