<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" :showGoBack="currentScreen !== 'overview'" @close="closeOverlay" @esc="closeOverlay" @goBack="goBack">
    <template #title>
      <div class="text-2xl font-bold grow">{{ title }}</div>
    </template>
    <div class="px-5 py-5">
      <ImportAccountOverview v-if="currentScreen === 'overview'" @close="closeOverlay" @goTo="goTo" />
      <ImportAccountFromMnemonic v-if="currentScreen === 'import-from-mnemonic'" @close="closeOverlay" @goTo="goTo" />
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import Overlay from './Overlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import ImportAccountOverview from './import-account/Overview.vue';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';

const emit = defineEmits(['close', 'goTo']);

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<'overview' | 'import-from-mnemonic'>('overview');
const overlayWidth = Vue.ref(640);

const title = Vue.computed(() => {
  if (currentScreen.value === 'overview') {
    return 'Import Account';
  } else if (currentScreen.value === 'import-from-mnemonic') {
    return 'Import From Mnemonic';
  }
  throw new Error('Invalid screen name');
});

function closeOverlay() {
  isOpen.value = false;
}

function goBack() {
  currentScreen.value = 'overview';
}

function goTo(screen: 'import-from-mnemonic') {
  currentScreen.value = screen;
  if (screen === 'import-from-mnemonic') {
    overlayWidth.value = 640;
  }
}

basicEmitter.on('openImportAccountOverlay', async (data: any) => {
  isOpen.value = true;
  currentScreen.value = 'overview';
});
</script>
