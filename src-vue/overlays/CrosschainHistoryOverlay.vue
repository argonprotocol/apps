<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-8/12" overflowScroll>
    <template #title>
      <div class="grow text-2xl font-bold">Crosschain History</div>
    </template>

    <div class="min-h-0 max-h-[calc(100vh-10rem)] overflow-y-auto px-5 pb-5">
      <div class="flex items-center gap-x-2 border-b border-slate-200 px-4 py-3 text-sm text-slate-500">
        <span
          v-if="crosschainHistory.data.isSyncing"
          class="border-argon-500 h-3.5 w-3.5 animate-spin rounded-full border-2 border-r-transparent"
        />
        <span v-if="crosschainHistory.data.isSyncing">Downloading newer indexed history</span>
        <span v-else-if="crosschainHistory.data.coverageComplete">Indexed history is caught up</span>
        <span v-else>{{ crosschainHistory.data.error ?? 'Indexed history is not complete yet' }}</span>
      </div>

      <CrosschainHistoryRows
        v-if="crosschainHistory.data.records.length"
        :records="crosschainHistory.data.records"
        :knownIdentities="knownSourceIdentities"
      />
      <div
        v-else-if="crosschainHistory.data.isSyncing"
        class="flex min-h-56 items-center justify-center text-sm font-semibold text-slate-500">
        Downloading crosschain history...
      </div>
      <div v-else class="flex min-h-56 items-center justify-center text-sm text-slate-500">
        No completed crosschain activity was found.
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import CrosschainHistoryRows from '../components/CrosschainHistoryRows.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { useBasics } from '../stores/basics.ts';
import { getCrosschainHistory, getKnownCrosschainSourceIdentities } from '../stores/vaults.ts';
import OverlayBase from './OverlayBase.vue';

const basics = useBasics();
const crosschainHistory = getCrosschainHistory();

const isOpen = Vue.ref(false);

const knownSourceIdentities = Vue.computed(() => {
  return getKnownCrosschainSourceIdentities();
});

function openOverlay(): void {
  isOpen.value = true;
  basics.overlayIsOpen = true;
  void crosschainHistory.refresh();
}

function closeOverlay(): void {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

Vue.onMounted(() => {
  basicEmitter.on('openCrosschainHistoryOverlay', openOverlay);
});

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openCrosschainHistoryOverlay', openOverlay);
});
</script>
