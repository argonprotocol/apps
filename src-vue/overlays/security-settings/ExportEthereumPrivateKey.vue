<!-- prettier-ignore -->
<template>
  <div class="flex flex-col gap-5 px-3">
    <div class="flex flex-col gap-3 text-md leading-6 text-slate-500">
      <p>
        This exports the private key for your default Ethereum wallet address. Any wallet that imports this key can
        spend funds from that Ethereum account.
      </p>
    </div>

    <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div class="text-xs font-semibold uppercase tracking-wide text-slate-500">Ethereum address</div>
      <div class="mt-2 break-all font-mono text-sm text-slate-900">{{ walletKeys.ethereumAddress }}</div>
    </div>

    <div class="relative rounded-xl border border-red-200 bg-red-50 px-4 py-3">
      <div class="text-xs font-semibold uppercase tracking-wide text-red-700">Private key</div>
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
        class="mt-2 pr-16 break-all font-mono text-sm text-slate-900 transition-all"
      >
        {{ privateKey }}
      </div>
      <div v-else-if="errorMessage" class="mt-2 text-sm text-red-700">{{ errorMessage }}</div>
      <div v-else class="mt-2 text-sm text-slate-500">Loading private key...</div>
    </div>

    <button
      @click="copyToClipboard"
      :disabled="!privateKey || !isPrivateKeyVisible"
      class="w-full rounded-lg border border-slate-900/10 bg-slate-600/20 px-4 py-2 text-slate-900 inner-button-shadow hover:bg-slate-600/15 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {{ isCopied ? 'Copied!' : 'Copy to Clipboard' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getWalletKeys } from '../../stores/wallets.ts';

const walletKeys = getWalletKeys();

const isCopied = Vue.ref(false);
const isPrivateKeyVisible = Vue.ref(false);
const privateKey = Vue.ref('');
const errorMessage = Vue.ref('');
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

    setTimeout(() => {
      isCopied.value = false;
    }, 2000);

    clearTimeout(clipboardClearTimer);
    const copiedValue = privateKey.value;
    clipboardClearTimer = setTimeout(() => {
      void (async () => {
        try {
          const currentClipboard = await navigator.clipboard.readText();
          if (currentClipboard === copiedValue) {
            await navigator.clipboard.writeText('');
          }
        } catch {
          // Ignore clipboard cleanup failures after the key has already been copied.
        }
      })();
    }, 180_000);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to copy the Ethereum private key.';
  }
}

Vue.onMounted(() => {
  walletKeys
    .exportEthereumPrivateKey()
    .then(key => {
      privateKey.value = key;
    })
    .catch(error => {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to export the Ethereum private key.';
    });
});

Vue.onUnmounted(() => {
  isPrivateKeyVisible.value = false;
  privateKey.value = '';
  errorMessage.value = '';
  clearTimeout(clipboardClearTimer);
});
</script>
