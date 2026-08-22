<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Private Key"
      :showHome="true"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    />

    <div class="flex grow flex-col gap-5 px-4 py-4">
      <p class="text-md leading-6 text-slate-500">
        This private key controls your Internal App Wallet. Anyone with this key can spend funds from its Argon account.
      </p>

      <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <div class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Public address</div>
        <div class="mt-2 font-mono text-sm break-all text-slate-900">{{ wallets.defaultArgonWallet.address }}</div>
      </div>

      <div class="relative rounded-xl border border-red-200 bg-red-50 px-4 py-3">
        <div class="text-xs font-semibold tracking-wide text-red-700 uppercase">Private key</div>
        <button
          @click="togglePrivateKeyVisibility"
          :disabled="!privateKey"
          class="absolute top-3 right-3 rounded-md border border-black/10 bg-white/75 px-2 py-1 text-xs font-semibold text-slate-600 backdrop-blur-sm hover:bg-white/90 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ isPrivateKeyVisible ? 'Hide' : 'Show' }}
        </button>
        <div
          v-if="privateKey"
          :class="isPrivateKeyVisible ? 'select-text' : 'select-none'"
          :style="{ filter: isPrivateKeyVisible ? 'none' : 'blur(10px)' }"
          class="mt-2 pr-16 font-mono text-sm break-all text-slate-900 transition-all"
        >
          {{ privateKey }}
        </div>
        <div v-else-if="errorMessage" class="mt-2 text-sm text-red-700">{{ errorMessage }}</div>
        <div v-else class="mt-2 text-sm text-slate-500">Loading private key...</div>
      </div>

      <button
        @click="copyToClipboard"
        :disabled="!privateKey || !isPrivateKeyVisible"
        class="inner-button-shadow w-full rounded-lg border border-slate-900/10 bg-slate-600/20 px-4 py-2 text-slate-900 hover:bg-slate-600/15 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ isCopied ? 'Copied!' : 'Copy to Clipboard' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();

const wallets = useWallets();
const walletKeys = getWalletKeys();

const isCopied = Vue.ref(false);
const isPrivateKeyVisible = Vue.ref(false);
const privateKey = Vue.ref('');
const errorMessage = Vue.ref('');
let copiedResetTimer: ReturnType<typeof setTimeout> | undefined;
let clipboardClearTimer: ReturnType<typeof setTimeout> | undefined;

function togglePrivateKeyVisibility() {
  if (!privateKey.value) return;
  isPrivateKeyVisible.value = !isPrivateKeyVisible.value;
}

async function copyToClipboard() {
  if (!privateKey.value || !isPrivateKeyVisible.value) return;

  try {
    await navigator.clipboard.writeText(privateKey.value);
    isCopied.value = true;

    clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      isCopied.value = false;
    }, 2_000);

    clearTimeout(clipboardClearTimer);
    const copiedValue = privateKey.value;
    clipboardClearTimer = setTimeout(() => {
      void clearCopiedPrivateKey(copiedValue);
    }, 180_000);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to copy the Argon private key.';
  }
}

async function clearCopiedPrivateKey(copiedValue: string) {
  try {
    const currentClipboard = await navigator.clipboard.readText();
    if (currentClipboard === copiedValue) await navigator.clipboard.writeText('');
  } catch {
    // Ignore clipboard cleanup failures after the key has already been copied.
  }
}

Vue.onMounted(() => {
  walletKeys
    .exportDefaultArgonPrivateKey()
    .then(key => {
      privateKey.value = key;
    })
    .catch(error => {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to export the Argon private key.';
    });
});

Vue.onUnmounted(() => {
  isPrivateKeyVisible.value = false;
  privateKey.value = '';
  errorMessage.value = '';
  clearTimeout(copiedResetTimer);
  clearTimeout(clipboardClearTimer);
});
</script>
