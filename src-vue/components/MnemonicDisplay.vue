<!-- prettier-ignore -->
<template>
  <div v-if="isLoading" class="flex justify-center py-6">
    <Spinner class="w-8 h-8" />
  </div>

  <div v-else-if="loadError" class="flex justify-center py-6 text-sm text-red-600">
    Failed to load recovery phrase. Please ensure your wallet is unlocked and try again.
  </div>

  <template v-else>
    <ol class="grid grid-cols-3 gap-x-4 gap-y-1.5 select-text" :class="gridClass">
      <li v-for="(word, index) in words" :key="index" class="flex items-center gap-2 py-1.5 px-3 rounded-md bg-slate-50 border border-slate-200/60">
        <span class="text-xs text-slate-400 font-mono w-4 text-right">{{ index + 1 }}</span>
        <span class="text-sm font-medium text-argon-text-primary">{{ word }}</span>
      </li>
    </ol>

    <slot :mnemonic="masterMnemonic" />
  </template>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getWalletKeys } from '../stores/wallets.ts';
import Spinner from './Spinner.vue';

defineProps<{
  gridClass?: string;
}>();

const walletKeys = getWalletKeys();

const isLoading = Vue.ref(true);
const masterMnemonic = Vue.ref('');
const words = Vue.computed(() => masterMnemonic.value.split(' ').filter(Boolean));
const loadError = Vue.ref<Error | null>(null);

Vue.onMounted(async () => {
  try {
    masterMnemonic.value = await walletKeys.exposeMasterMnemonic();
  } catch (error) {
    loadError.value = error instanceof Error ? error : new Error('Failed to load mnemonic');
    masterMnemonic.value = '';
  } finally {
    isLoading.value = false;
  }
});
</script>
