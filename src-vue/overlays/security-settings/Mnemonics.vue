<!-- prettier-ignore -->
<template>
  <p class="text-md text-slate-500 px-3">
    The following words constitute your wallet recovery phrase (the order is important). They are used to recover your
    wallet if this device or app is lost or damaged. Keep them in a safe place! Anyone who knows this mnemonic can
    access your wallet and funds.
  </p>
  <div v-if="errorMessage" class="mt-4 flex items-start rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-sm text-yellow-900" role="alert">
    <AlertIcon class="mr-2 mt-0.5 h-4 shrink-0 text-yellow-700" aria-hidden="true" />
    <span>{{ errorMessage }}</span>
  </div>

  <ol v-if="masterMnemonic" class="grid grid-cols-3 gap-2 px-3 mt-5 mb-6 ml-6 cursor-text">
    <li v-for="(word, index) in words" :key="word" class="flex items-center gap-2 py-1">
      <span class="text-slate-500">{{ index + 1 }}.</span>
      <span class="select-text">{{ word }}</span>
    </li>
  </ol>
  <div v-else-if="!errorMessage" class="flex items-center px-3 mt-5 mb-6 text-slate-500" role="status">
    <Spinner />
    Loading mnemonic…
  </div>

  <button @click="copyToClipboard" :disabled="!masterMnemonic" class="w-full bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-2 rounded-lg focus:outline-none cursor-pointer">
    <span v-if="isCopied">
      Copied!
    </span>
    <span v-else class="relative">
      Copy to Clipboard
      <ArrowCalloutButton
        v-if="controller && controller.activeGuideId === OperationalStepId.BackupMnemonic"
        class="absolute top-1/2 -right-4 -translate-y-1/2 translate-x-full z-50"
        guidance="Click to copy onto your clipboard."
      />
    </span>
  </button>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { exposeMasterMnemonic } from '../../stores/wallets.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import Spinner from '../../components/Spinner.vue';
import { getConfig } from '../../stores/config.ts';
import AlertIcon from '../../assets/alert.svg?component';
import { useStartupStore } from '../../stores/startup.ts';
import { clearCopiedSecretLater } from '../../lib/clipboardSecrets.ts';

const startup = useStartupStore();
const config = startup.isWalletReady ? getConfig() : undefined;
const controller = startup.isWalletReady ? useCertificationController() : undefined;

const isCopied = Vue.ref(false);
const masterMnemonic = Vue.ref('');
const errorMessage = Vue.ref('');
const words = Vue.computed(() => masterMnemonic.value.split(' '));
let copiedResetTimer: ReturnType<typeof setTimeout> | undefined;
let isUnmounted = false;

const emit = defineEmits(['close', 'goTo']);

async function copyToClipboard() {
  if (!masterMnemonic.value) return;
  const copiedValue = masterMnemonic.value;
  try {
    await navigator.clipboard.writeText(copiedValue);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to copy the recovery phrase.';
    return;
  }
  clearCopiedSecretLater(copiedValue);
  if (isUnmounted) return;
  isCopied.value = true;
  clearTimeout(copiedResetTimer);
  copiedResetTimer = setTimeout(() => {
    isCopied.value = false;
    config?.setCertificationDetails({ hasSavedMnemonic: true });
    if (controller && controller.activeGuideId === OperationalStepId.BackupMnemonic) {
      emit('close');
    }
  }, 2000);
}

Vue.onMounted(async () => {
  try {
    if (isUnmounted) return;
    const mnemonic = await exposeMasterMnemonic();
    if (!isUnmounted) masterMnemonic.value = mnemonic;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
});

Vue.onUnmounted(() => {
  isUnmounted = true;
  masterMnemonic.value = '';
  clearTimeout(copiedResetTimer);
});
</script>
