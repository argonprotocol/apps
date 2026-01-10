<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-lg">
    <template #title>
      <div class="text-2xl font-bold grow">Move Your Funds</div>
    </template>
    <div class="px-6 py-4 text-sm font-medium text-gray-700">
      <MoveCapitalCore :isOpen="isOpen" @close="closeOverlay" />
    </div>
  </Overlay>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import Overlay from './Overlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import MoveCapitalCore from './move-capital/MoveCapitalCore.vue';

const isOpen = Vue.ref(false);

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openMoveCapitalOverlay', async data => {
  isOpen.value = true;
});
</script>
