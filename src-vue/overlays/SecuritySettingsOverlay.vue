<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showGoBack="currentScreen !== 'overview'" @close="closeOverlay" @pressEsc="closeOverlay" @goBack="goBack"
    :style="{ width: `${overlayWidth}px` }"
  >
    <template #title>
      <div class="text-2xl font-bold grow">{{ title }}</div>
    </template>

    <div class="px-3 py-4">
      <SecuritySettingsOverview
        v-if="currentScreen === 'overview'"
        :hasDefaultEthereumWallet="!!defaultEthereumWallet"
        @close="closeOverlay"
        @goTo="goTo"
      />
      <SecuritySettingsMnemonics v-if="currentScreen === 'mnemonics'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsSSHAccess v-if="currentScreen === 'ssh'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsEncrypt v-if="currentScreen === 'encrypt'" @close="closeOverlay" @goTo="goTo" />
      <SecuritySettingsExportEthereumPrivateKey
        v-if="currentScreen === 'ethereum-export' && defaultEthereumWallet"
        :walletRecord="defaultEthereumWallet"
        @close="closeOverlay"
        @goTo="goTo"
      />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import SecuritySettingsOverview from './security-settings/Overview.vue';
import SecuritySettingsEncrypt from './security-settings/Encrypt.vue';
import SecuritySettingsExportEthereumPrivateKey from './security-settings/ExportEthereumPrivateKey.vue';
import SecuritySettingsMnemonics from './security-settings/Mnemonics.vue';
import SecuritySettingsSSHAccess from './security-settings/SSHAccess.vue';
import OverlayBase from './OverlayBase.vue';
import { useBasics } from '../stores/basics.ts';
import { useWallets } from '../stores/wallets.ts';

const basics = useBasics();
const wallets = useWallets();

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<'overview' | 'mnemonics' | 'ssh' | 'encrypt' | 'ethereum-export'>('overview');
const overlayWidth = Vue.ref(640);
const defaultEthereumWallet = Vue.computed(() =>
  wallets.walletRecords.find(record => record.role === 'defaultEthereum'),
);

const title = Vue.computed(() => {
  if (currentScreen.value === 'overview') {
    return 'Security and Backup';
  } else if (currentScreen.value === 'encrypt') {
    return 'Encryption Passphrase';
  } else if (currentScreen.value === 'ssh') {
    return 'Connect to Mining Machine';
  } else if (currentScreen.value === 'mnemonics') {
    return 'Account Recovery Mnemonic';
  } else if (currentScreen.value === 'ethereum-export') {
    return 'Export Default Ethereum Private Key';
  }
  throw new Error('Invalid screen name');
});

basicEmitter.on('openSecuritySettingsOverlay', async data => {
  const requestedScreen = data?.screen ?? 'overview';
  if (requestedScreen === 'ethereum-export' && !wallets.isLoaded) {
    try {
      await wallets.load();
    } catch (error) {
      console.error('Failed to load wallet records before opening the Default Ethereum export', error);
    }
  }

  isOpen.value = true;
  currentScreen.value =
    requestedScreen === 'ethereum-export' && !defaultEthereumWallet.value ? 'overview' : requestedScreen;
  basics.overlayIsOpen = true;
});

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function goBack() {
  currentScreen.value = 'overview';
}

function goTo(screen: 'overview' | 'encrypt' | 'mnemonics' | 'ssh' | 'ethereum-export') {
  if (screen === 'ethereum-export' && !defaultEthereumWallet.value) return;

  currentScreen.value = screen;
  if (screen === 'overview') {
    overlayWidth.value = 640;
  } else if (screen === 'encrypt') {
    overlayWidth.value = 640;
  } else if (screen === 'mnemonics') {
    overlayWidth.value = 740;
  } else if (screen === 'ssh' || screen === 'ethereum-export') {
    overlayWidth.value = 740;
  }
}
</script>
