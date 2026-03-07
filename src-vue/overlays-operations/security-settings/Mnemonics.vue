<!-- prettier-ignore -->
<template>
  <p class="text-md text-slate-500 px-3">
    The following words constitute your wallet recovery phrase (the order is important). They are used to recover your
    wallet if this device or app is lost or damaged. Keep them in a safe place! Anyone who knows this mnemonic can
    access your wallet and funds.
  </p>

  <ol class="grid grid-cols-3 gap-2 px-3 mt-5 mb-6 ml-6 cursor-text">
    <li v-for="(word, index) in words" :key="word" class="flex items-center gap-2 py-1">
      <span class="text-slate-500">{{ index + 1 }}.</span>
      <span class="select-text">{{ word }}</span>
    </li>
  </ol>

  <button @click="copyToClipboard" class="w-full bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-2 rounded-lg focus:outline-none cursor-pointer">
    <span v-if="isCopied">
      Copied!
    </span>
    <span v-else class="relative">
      Copy to Clipboard
      <ArrowCalloutButton
        v-if="controller.activeGuideId === OperationalStepId.BackupMnemonic"
        class="absolute top-1/2 -right-4 -translate-y-1/2 translate-x-full z-50"
        guidance="Click to copy onto your clipboard."
      />
    </span>
  </button>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getWalletKeys } from '../../stores/wallets.ts';
import { OperationalStepId, useOperationsController } from '../../stores/operationsController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getConfig } from '../../stores/config.ts';

const config = getConfig();
const walletKeys = getWalletKeys();
const controller = useOperationsController();

const isCopied = Vue.ref(false);
const masterMnemonic = Vue.ref('');
const words = Vue.computed(() => masterMnemonic.value.split(' '));
let clipboardClearTimer: ReturnType<typeof setTimeout> | undefined;

const emit = defineEmits(['close', 'goTo']);

function copyToClipboard() {
  navigator.clipboard.writeText(masterMnemonic.value);
  isCopied.value = true;
  setTimeout(() => {
    isCopied.value = false;
    config.setCertificationDetails({ hasSavedMnemonic: true });
    if (controller.activeGuideId === OperationalStepId.BackupMnemonic) {
      emit('close');
      basicEmitter.emit('openOperationalFinishOverlay');
    }
  }, 2000);
  clearTimeout(clipboardClearTimer);
  const copiedValue = masterMnemonic.value;
  clipboardClearTimer = setTimeout(async () => {
    const current = await navigator.clipboard.readText();
    if (current === copiedValue) {
      navigator.clipboard.writeText('');
    }
  }, 180_000);
}

Vue.onMounted(() => {
  walletKeys.exposeMasterMnemonic().then(x => {
    masterMnemonic.value = x;
  });
});

Vue.onUnmounted(() => {
  masterMnemonic.value = '';
  clearTimeout(clipboardClearTimer);
});
</script>
