<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" >
    <template #title>
      <div class="text-2xl font-bold grow">{{ title }}</div>
    </template>
    <div class="px-5 py-5">
      <ImportAccountFromMnemonic @close="closeOverlay" />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';

const isOpen = Vue.ref(false);

const title = Vue.computed(() => {
  return 'Import From Mnemonic';
});

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openImportAccountOverlay', async () => {
  isOpen.value = true;
});
</script>
