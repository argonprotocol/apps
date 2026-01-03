<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" :showGoBack="currentScreen !== 'overview'" @close="closeOverlay" @esc="closeOverlay" @goBack="goBack"
    :style="{ width: `${overlayWidth}px` }"
  >
    <template #title>
      <div class="text-2xl font-bold grow">{{ title }}</div>
    </template>

    <div class="px-3 py-4">
      <SecuritySettingsOverview v-if="currentScreen === 'overview'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsMnemonics v-if="currentScreen === 'mnemonics'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsSSHKeys v-if="currentScreen === 'ssh'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsEncrypt v-if="currentScreen === 'encrypt'" @close="closeOverlay" @goTo="goTo" />
      <ExportRecoveryFile v-if="currentScreen === 'export'" @close="closeOverlay" @goTo="goTo" />
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter';
import SecuritySettingsOverview from './security-settings/Overview.vue';
import SecuritySettingsEncrypt from './security-settings/Encrypt.vue';
import SecuritySettingsMnemonics from './security-settings/Mnemonics.vue';
import SecuritySettingsSSHKeys from './security-settings/SSHKeys.vue';
import ExportRecoveryFile from './security-settings/ExportRecoveryFile.vue';
import Overlay from './Overlay.vue';

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<'overview' | 'mnemonics' | 'ssh' | 'encrypt' | 'export'>('overview');
const overlayWidth = Vue.ref(640);

const title = Vue.computed(() => {
  if (currentScreen.value === 'overview') {
    return 'Security and Backup';
  } else if (currentScreen.value === 'encrypt') {
    return 'Encryption Passphrase';
  } else if (currentScreen.value === 'ssh') {
    return 'SSH Keys for Mining Machine';
  } else if (currentScreen.value === 'mnemonics') {
    return 'Account Recovery Mnemonic';
  } else if (currentScreen.value === 'export') {
    return 'Export Account Backup File';
  }
  throw new Error('Invalid screen name');
});

basicEmitter.on('openSecuritySettingsOverlay', async (data: any) => {
  isOpen.value = true;
  currentScreen.value = 'overview';
});

function closeOverlay() {
  isOpen.value = false;
}

function goBack() {
  currentScreen.value = 'overview';
}

function goTo(screen: 'overview' | 'encrypt' | 'mnemonics' | 'ssh' | 'export') {
  currentScreen.value = screen;
  if (screen === 'overview') {
    overlayWidth.value = 640;
  } else if (screen === 'encrypt') {
    overlayWidth.value = 640;
  } else if (screen === 'mnemonics') {
    overlayWidth.value = 740;
  } else if (screen === 'ssh') {
    overlayWidth.value = 740;
  } else if (screen === 'export') {
    overlayWidth.value = 740;
  }
}
</script>
