<!-- prettier-ignore -->
<template>
  <div class="flex flex-col px-3">
    <p class="text-md text-slate-500">
      All your data in this Argon Investor Console app can be entirely recreated from a single account recovery file. Click
      the button below to download. And keep it safe! It contains your account's private key, so don't share it with anyone.
    </p>

    <div v-if="errorMessage" class="bg-red-50 border border-red-200 rounded-md p-3 mt-3 mb-2">
      <p class="text-red-700 text-sm">
        {{ errorMessage }}
      </p>
    </div>

    <ol class="grid grid-cols-3 gap-y-2 gap-x-5 pr-3 mt-5 mb-6 ml-1">
      <li v-for="i in 12" :key="i" class="flex flex-row items-center gap-2 py-1">
        <span class="text-slate-500 font-mono text-md">{{ `${i}.`.padStart(3, '&nbsp;') }}</span>
        <input
          type="text"
          :class="[hasErrors && !mnemonic[i - 1] ? 'border-red-600 outline-2 outline-red-500/30' : 'border-slate-300']"
          class="w-full border rounded-md p-2"
          v-model="mnemonic[i - 1]"
          @paste="handlePaste"
          @input="validateMnemonic"
        />
      </li>
    </ol>

    <button class="bg-argon-600 text-white rounded-md py-2 px-3 mb-1 cursor-pointer" @click="importAccount">
      {{ isImporting ? 'Importing Account...' : 'Import Account' }}
    </button>

  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../../stores/config';
import { useController } from '../../stores/controller';
import { getWalletKeys } from '../../stores/wallets.ts';

const config = getConfig();
const controller = useController();

const mnemonic = Vue.ref(['', '', '', '', '', '', '', '', '', '', '', '']);
const errorMessage = Vue.ref('');
const hasErrors = Vue.ref(false);
const isImporting = Vue.ref(false);

const emit = defineEmits(['close', 'goTo']);

function goTo(screen: 'import-from-mnemonic') {
  emit('goTo', screen);
}

function handlePaste(event: ClipboardEvent) {
  event.preventDefault();

  const pastedText = event.clipboardData?.getData('text') || '';
  const words = pastedText
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0);

  if (words.length === 0) return;

  errorMessage.value = '';
  words.forEach((word, i) => {
    if (i < 12) mnemonic.value[i] = word;
  });
}

function validateMnemonic() {
  // Clear error when user manually types
  errorMessage.value = '';

  // Check if all fields are filled
  const filledWords = mnemonic.value.filter(word => word.trim().length > 0);

  if (filledWords.length > 0 && filledWords.length !== 12) {
    errorMessage.value = `Please enter exactly 12 words. You have ${filledWords.length} word${filledWords.length === 1 ? '' : 's'}.`;
  }
}

async function importAccount() {
  hasErrors.value = mnemonic.value.some(word => !word);
  if (hasErrors.value) return;

  const masterMnemonic = await getWalletKeys().exposeMasterMnemonic();

  const hasSameMnemonic = masterMnemonic === mnemonic.value.join(' ');
  if (hasSameMnemonic) {
    errorMessage.value = 'The mnemonic you entered is the same as your current account.';
    return;
  }

  isImporting.value = true;

  await controller.importFromMnemonic(mnemonic.value.join(' '));

  isImporting.value = false;
  emit('close');
}
</script>
