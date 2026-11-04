<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showGoBack="!mnemonicOnly && currentScreen !== 'overview'" @close="closeOverlay" @pressEsc="closeOverlay" @goBack="goBack"
    :style="{ width: currentScreen === 'mnemonics' ? '740px' : '640px' }"
  >
    <template #title>
      <div class="text-2xl font-bold grow">{{ title }}</div>
    </template>

    <div class="px-3 py-4">
      <SecuritySettingsOverview
        v-if="currentScreen === 'overview'"
        @close="closeOverlay"
        @goTo="goTo"
      />
      <SecuritySettingsMnemonics v-if="currentScreen === 'mnemonics'" @close="closeOverlay" @goTo="goTo" />
      <KeepAlive v-if="isOpen">
        <AccountSecurity v-if="currentScreen === 'accountSecurity'" @close="closeOverlay" @goTo="goTo" />
      </KeepAlive>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter, { type SecuritySettingsScreen } from '../emitters/basicEmitter.ts';
import SecuritySettingsOverview from './security-settings/Overview.vue';
import AccountSecurity from './security-settings/AccountSecurity.vue';
import SecuritySettingsMnemonics from './security-settings/Mnemonics.vue';
import OverlayBase from './OverlayBase.vue';
import { useBasics } from '../stores/basics.ts';

const basics = useBasics();
const { mnemonicOnly = false } = defineProps<{ mnemonicOnly?: boolean }>();

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<SecuritySettingsScreen>('overview');
const screenHistory: SecuritySettingsScreen[] = [];

const title = Vue.computed(() => {
  if (currentScreen.value === 'overview') {
    return 'Security and Backup';
  } else if (currentScreen.value === 'accountSecurity') {
    return 'Account Security';
  } else if (currentScreen.value === 'mnemonics') {
    return 'Account Recovery Mnemonic';
  }
  throw new Error('Invalid screen name');
});

function openOverlay(data: { screen: SecuritySettingsScreen } | undefined) {
  const requestedScreen = mnemonicOnly ? 'mnemonics' : (data?.screen ?? 'overview');

  isOpen.value = true;
  screenHistory.length = 0;
  currentScreen.value = requestedScreen;
  basics.overlayIsOpen = true;
}

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function goBack() {
  currentScreen.value = screenHistory.pop() ?? 'overview';
}

function goTo(screen: SecuritySettingsScreen) {
  if (screen === currentScreen.value) return;
  screenHistory.push(currentScreen.value);
  currentScreen.value = screen;
}

basicEmitter.on('openSecuritySettingsOverlay', openOverlay);
Vue.onUnmounted(() => basicEmitter.off('openSecuritySettingsOverlay', openOverlay));
</script>
