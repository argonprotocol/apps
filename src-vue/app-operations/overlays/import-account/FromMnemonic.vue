<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-col px-3">
    <p class="text-md text-slate-500">
      You can import an existing account with nothing more than the twelve words that comprise your mnemonic.
      Enter the words below and click Import Account.
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

    <button
      v-if="showButton"
      class="bg-argon-600 text-white rounded-md py-2 px-3 mb-1 cursor-pointer"
      @click="importAccount"
    >
      {{ isImporting ? 'Importing Account...' : 'Import Account' }}
    </button>

  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useOperationsController } from '../../../stores/operationsController.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';

withDefaults(
  defineProps<{
    showButton?: boolean;
  }>(),
  {
    showButton: true,
  },
);

const controller = useOperationsController();

const rootRef = Vue.ref<HTMLElement | null>(null);
const mnemonic = Vue.ref(['', '', '', '', '', '', '', '', '', '', '', '']);
const errorMessage = Vue.ref('');
const hasErrors = Vue.ref(false);
const isImporting = Vue.ref(false);

const emit = defineEmits(['close']);

function fillMnemonicFromText(pastedText: string) {
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

function handlePaste(event: ClipboardEvent) {
  event.preventDefault();
  fillMnemonicFromText(event.clipboardData?.getData('text') || '');
}

function isEditableElement(element: Element | null): element is HTMLElement {
  return (
    !!element &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLElement)
  );
}

function handleWindowPaste(event: ClipboardEvent) {
  const root = rootRef.value;
  if (!root) return;

  const activeElement = document.activeElement;
  const shouldIgnorePaste =
    isEditableElement(activeElement) &&
    activeElement !== document.body &&
    !root.contains(activeElement) &&
    (activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement ||
      activeElement.isContentEditable);

  if (shouldIgnorePaste) return;

  event.preventDefault();
  fillMnemonicFromText(event.clipboardData?.getData('text') || '');
}

Vue.onMounted(() => {
  window.addEventListener('paste', handleWindowPaste);
});

Vue.onBeforeUnmount(() => {
  window.removeEventListener('paste', handleWindowPaste);
});

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
  if (hasErrors.value) return false;

  const masterMnemonic = await getWalletKeys().exposeMasterMnemonic();

  const hasSameMnemonic = masterMnemonic === mnemonic.value.join(' ');
  if (hasSameMnemonic) {
    errorMessage.value = 'The mnemonic you entered is the same as your current account.';
    return false;
  }

  isImporting.value = true;

  await controller.importFromMnemonic(mnemonic.value.join(' '));

  isImporting.value = false;
  mnemonic.value.fill('');
  emit('close');
  return true;
}

Vue.onUnmounted(() => {
  mnemonic.value.fill('');
});

defineExpose({
  importAccount,
});
</script>
