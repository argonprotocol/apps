<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-col px-3">
    <div v-if="isSettingPasscode" class="py-5">
      <p class="mb-4 text-slate-600">Set a new app passcode for your current account.</p>
      <NewPasscodeField
        v-model="newPasscode"
        :disabled="isImporting"
        label="New passcode"
      />
      <p v-if="errorMessage" class="mt-4 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <footer class="mt-6 flex justify-end gap-2 border-t border-slate-300 pt-3">
        <button
          type="button"
          :disabled="isImporting"
          class="cursor-pointer rounded-md border border-slate-300 px-4 py-1 font-bold text-slate-600 hover:bg-slate-50"
          @click="closeOverlay"
        >Cancel</button>
        <button
          type="button"
          :disabled="isImporting || [...newPasscode].length < AccountSecurity.minimumPasscodeLength"
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-4 py-1 font-bold text-white disabled:cursor-default disabled:opacity-50"
          @click="resetPasscode"
        >
          <template v-if="isImporting">Saving…</template>
          <template v-else>Save</template>
        </button>
      </footer>
    </div>
    <template v-else>
      <p class="text-md text-slate-500">
      <template v-if="recoveryOnly">Enter your saved account's twelve-word mnemonic to restore access.</template>
      <template v-else>You can import an existing account with nothing more than the twelve words that comprise your mnemonic. Enter the words below and click Import Account.</template>
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
          :aria-label="`Mnemonic word ${i}`"
          :disabled="isImporting"
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
      :disabled="isImporting"
      class="bg-argon-600 text-white rounded-md py-2 px-3 mb-1 cursor-pointer"
      @click="importAccount"
    >
      <template v-if="isImporting">Checking account…</template>
      <template v-else-if="recoveryOnly">Recover Account</template>
      <template v-else>Import Account</template>
    </button>
    <button
      v-if="recoveryOnly"
      type="button"
      :disabled="isImporting"
      class="mt-3 cursor-pointer text-sm text-slate-600 underline"
      @click="closeOverlay"
    >Back to unlock</button>
    </template>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { AccountSecurity } from '../../lib/AccountSecurity.ts';
import NewPasscodeField from '../../components/NewPasscodeField.vue';
import { useStartupStore } from '../../stores/startup.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { WalletRecoveryError } from '../../lib/WalletSecrets.ts';
import type { EncryptionAuthentication } from '../../lib/EncryptionSecret.ts';
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import { getConfig, type Config } from '../../stores/config.ts';

const props = withDefaults(
  defineProps<{
    showButton?: boolean;
    recoveryOnly?: boolean;
  }>(),
  {
    showButton: true,
  },
);

const rootRef = Vue.ref<HTMLElement | null>(null);
const mnemonic = Vue.ref(['', '', '', '', '', '', '', '', '', '', '', '']);
const errorMessage = Vue.ref('');
const hasErrors = Vue.ref(false);
const isImporting = Vue.ref(false);
const isSettingPasscode = Vue.ref(false);
const newPasscode = Vue.ref('');

const emit = defineEmits<{ close: []; recovered: [authentication: EncryptionAuthentication] }>();

function fillMnemonicFromText(pastedText: string) {
  const words = pastedText
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0);

  if (words.length === 0) return;
  if (words.length !== 12) {
    errorMessage.value = 'Please enter exactly 12 words.';
    return;
  }

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
  if (isImporting.value || isSettingPasscode.value) return;
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
  mnemonic.value.fill('');
  newPasscode.value = '';
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
  if (isImporting.value || isSettingPasscode.value) return false;
  hasErrors.value = mnemonic.value.some(word => !word);
  if (hasErrors.value) return false;

  errorMessage.value = '';
  isImporting.value = true;
  try {
    const importedMnemonic = mnemonic.value.map(word => word.trim()).join(' ');
    if (props.recoveryOnly) {
      if (!(await AccountSecurity.matchesSavedMnemonic(importedMnemonic))) {
        errorMessage.value = 'The recovery phrase does not match this saved account.';
        return false;
      }
      isSettingPasscode.value = true;
      return false;
    }
    if (await getWalletKeys().matchesMnemonic(importedMnemonic)) {
      errorMessage.value = 'The mnemonic you entered is the same as your current account.';
      return false;
    }

    if (!(await useStartupStore().importFromMnemonic(importedMnemonic))) return false;
    closeOverlay();
    return true;
  } catch (error) {
    errorMessage.value =
      error instanceof Error && error.message ? error.message : 'Unable to import that account right now.';
    return false;
  } finally {
    isImporting.value = false;
  }
}

function closeOverlay() {
  mnemonic.value.fill('');
  isSettingPasscode.value = false;
  newPasscode.value = '';
  emit('close');
}

async function resetPasscode() {
  if (isImporting.value || [...newPasscode.value].length < AccountSecurity.minimumPasscodeLength) return;
  errorMessage.value = '';
  isImporting.value = true;
  try {
    await AccountSecurity.recoverWithNewPasscode({
      mnemonic: mnemonic.value.join(' '),
      newPasscode: newPasscode.value,
      db: await getDbPromise(),
      config: getConfig() as Config,
    });
    const authentication = { passcode: newPasscode.value };
    emit('recovered', authentication);
    closeOverlay();
  } catch (error) {
    console.error('Unable to restore account access.', error);
    errorMessage.value =
      error instanceof WalletRecoveryError ? error.message : 'Account recovery could not finish. Please try again.';
  } finally {
    isImporting.value = false;
  }
}

defineExpose({
  importAccount,
});
</script>
