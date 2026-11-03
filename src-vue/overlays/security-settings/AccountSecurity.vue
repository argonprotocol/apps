<template>
  <div v-if="!walletKeys.canSign" class="px-6 py-6">
    <p class="mb-6 text-slate-600">Use your recovery phrase to restore signing access to this account.</p>
    <FromMnemonic recovery-only @close="emit('close')" @recovered="reloadAccount" />
  </div>
  <div v-else class="px-6 py-6">
    <p class="mb-6 text-slate-600">
      Secure your account's encryption key. This requires you to unlock the app when opening it, moving funds, or
      revealing secret keys.
    </p>

    <p v-if="isLoading" class="mb-6 text-sm text-slate-500">Loading Account Security…</p>
    <p v-else-if="!systemOption && !errorMessage" class="mb-6 text-sm text-slate-500">
      System authentication is not available on this device.
    </p>

    <fieldset :disabled="isBusy || !hasLoaded" class="divide-y divide-slate-200">
      <legend class="sr-only">Authentication method</legend>
      <div v-if="systemOption || savedMethod === 'system'">
        <!-- prettier-ignore -->
        <label class="hover:to-argon-menu-hover/70 focus-within:ring-argon-600 flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-4 text-left text-slate-700 focus-within:ring-2 hover:bg-gradient-to-r hover:from-transparent">
          <input v-model="selectedOption" type="radio" :name="inputId" value="system" :disabled="!systemOption" class="sr-only" />
          <FingerPrintIcon
            v-if="systemOption === 'touchId' || systemOption === 'fingerprint'"
            class="h-6 w-6 shrink-0 text-slate-500"
            aria-hidden="true"
          />
          <FaceSmileIcon
            v-else-if="systemOption === 'faceId'"
            class="h-6 w-6 shrink-0 text-slate-500"
            aria-hidden="true"
          />
          <ComputerDesktopIcon v-else class="h-6 w-6 shrink-0 text-slate-500" aria-hidden="true" />
          <span class="grow font-semibold">
            <template v-if="systemOption === 'touchId'">Touch ID</template>
            <template v-else-if="systemOption === 'faceId'">Face ID</template>
            <template v-else-if="systemOption === 'windowsHello'">Windows Hello</template>
            <template v-else-if="systemOption === 'fingerprint'">Fingerprint</template>
            <template v-else>System authentication</template>
          </span>
          <CheckIcon
            v-if="selectedOption === 'system'"
            class="text-argon-600 h-5 w-5 shrink-0"
            aria-hidden="true"
          />
        </label>
      </div>
      <div>
        <!-- prettier-ignore -->
        <label class="hover:to-argon-menu-hover/70 focus-within:ring-argon-600 flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-4 text-left text-slate-700 focus-within:ring-2 hover:bg-gradient-to-r hover:from-transparent">
          <input v-model="selectedOption" type="radio" :name="inputId" value="passcode" class="sr-only" />
          <KeyIcon class="h-6 w-6 shrink-0 text-slate-500" aria-hidden="true" />
          <span class="grow font-semibold">App Passcode</span>
          <CheckIcon v-if="selectedOption === 'passcode'" class="text-argon-600 h-5 w-5 shrink-0" aria-hidden="true" />
        </label>
        <NewPasscodeField
          v-if="selectedOption === 'passcode'"
          v-model="passcode"
          :placeholder="savedMethod === 'passcode' ? 'Enter a new passcode' : 'Enter a passcode'"
          class="px-3 pb-4"
        />
      </div>
      <div>
        <!-- prettier-ignore -->
        <label class="hover:to-argon-menu-hover/70 focus-within:ring-argon-600 flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-4 text-left text-slate-700 focus-within:ring-2 hover:bg-gradient-to-r hover:from-transparent">
          <input v-model="selectedOption" type="radio" :name="inputId" value="none" class="sr-only" />
          <NoSymbolIcon class="h-6 w-6 shrink-0 text-slate-500" aria-hidden="true" />
          <span class="grow font-semibold">None</span>
          <CheckIcon v-if="selectedOption === 'none'" class="text-argon-600 h-5 w-5 shrink-0" aria-hidden="true" />
        </label>
      </div>
    </fieldset>

    <div v-if="savedMethod === 'passcode' && isDirty" class="my-4 px-3">
      <label :for="`${inputId}-current-passcode`" class="mb-2 block text-sm font-semibold text-slate-700">
        Current passcode
      </label>
      <input
        :id="`${inputId}-current-passcode`"
        v-model="currentPasscode"
        type="password"
        autocomplete="current-password"
        :disabled="isBusy"
        class="focus:border-argon-500 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none"
      />
    </div>

    <div v-if="selectedOption !== 'none'" class="my-5 border-t border-slate-200 pt-4 text-sm text-slate-600">
      <div class="flex items-center justify-between gap-3">
        <p class="font-semibold text-slate-700">Mnemonic backup</p>
        <button type="button" class="cursor-pointer font-semibold underline" @click="emit('goTo', 'mnemonics')">
          Back-up mnemonic
        </button>
      </div>
      <p class="mt-2">
        Without a backup, losing access to your passcode or device could permanently lock you out of your funds.
      </p>
      <label class="mt-3 flex cursor-pointer items-center gap-2">
        <input v-model="hasConfirmedBackup" type="checkbox" :disabled="isBusy" class="peer sr-only" />
        <Checkbox
          :isChecked="hasConfirmedBackup"
          :size="4"
          class="peer-focus-visible:ring-argon-600 peer-focus-visible:ring-2"
          aria-hidden="true"
        />
        I have saved the mnemonic in a safe place.
      </label>
    </div>

    <div
      v-if="errorMessage"
      class="my-4 flex items-start rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-sm text-yellow-900"
      role="alert"
    >
      <AlertIcon class="mt-0.5 mr-2 h-4 shrink-0 text-yellow-700" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
    </div>
    <button
      v-if="errorMessage && !hasLoaded"
      type="button"
      :disabled="isLoading"
      class="mb-4 text-sm font-semibold text-slate-600"
      @click="loadSettings()"
    >
      Try again
    </button>

    <footer class="flex justify-end gap-2 border-t border-slate-300 pt-3">
      <button
        type="button"
        :disabled="isSaving"
        class="cursor-pointer rounded-md border border-slate-300 px-4 py-1 font-bold text-slate-600 hover:bg-slate-50"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        :disabled="!canSave"
        @click="saveSettings"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-4 py-1 font-bold text-white disabled:cursor-default disabled:opacity-50"
      >
        <template v-if="isSaving">Saving…</template>
        <template v-else>Save</template>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  CheckIcon,
  ComputerDesktopIcon,
  FaceSmileIcon,
  FingerPrintIcon,
  KeyIcon,
  NoSymbolIcon,
} from '@heroicons/vue/24/outline';
import { AccountSecurity, type AccountSecurityMethod } from '../../lib/AccountSecurity.ts';
import NewPasscodeField from '../../components/NewPasscodeField.vue';
import { configureAccountSecurity, getAccountSecurity, getWalletKeys } from '../../stores/wallets.ts';
import FromMnemonic from '../import-account/FromMnemonic.vue';
import { getConfig } from '../../stores/config.ts';
import AlertIcon from '../../assets/alert.svg?component';
import Checkbox from '../../components/Checkbox.vue';

const emit = defineEmits(['close', 'goTo']);
const accountSecurity = getAccountSecurity();
const walletKeys = getWalletKeys();
const config = getConfig();

const systemOption = Vue.computed(() => accountSecurity.data.systemOption);
const savedMethod = Vue.computed(() => accountSecurity.data.method);
const isLoading = Vue.ref(false);
const hasLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);
const isBusy = Vue.computed(() => isLoading.value || isSaving.value);
const errorMessage = Vue.ref('');

const selectedOption = Vue.ref<AccountSecurityMethod>('none');
const passcode = Vue.ref('');
const currentPasscode = Vue.ref('');
const hasConfirmedBackup = Vue.ref(false);
const inputId = Vue.useId();

Vue.watch(
  () => config.certificationDetails?.hasSavedMnemonic,
  hasSavedMnemonic => {
    hasConfirmedBackup.value = !!hasSavedMnemonic;
  },
  { immediate: true },
);

const needsMnemonicBackup = Vue.computed(
  () =>
    savedMethod.value === 'none' && selectedOption.value !== 'none' && !config.certificationDetails?.hasSavedMnemonic,
);
const isDirty = Vue.computed(() => selectedOption.value !== savedMethod.value || passcode.value.length > 0);
const canSave = Vue.computed(() => {
  if (!hasLoaded.value || isBusy.value || !isDirty.value) return false;
  if (selectedOption.value !== 'none' && !hasConfirmedBackup.value) return false;
  if (selectedOption.value === 'passcode' && [...passcode.value].length < AccountSecurity.minimumPasscodeLength)
    return false;
  if (savedMethod.value === 'passcode' && !currentPasscode.value) return false;
  return true;
});

Vue.watch(selectedOption, () => {
  passcode.value = '';
  currentPasscode.value = '';
  errorMessage.value = '';
});

async function loadSettings() {
  if (isBusy.value) return;

  errorMessage.value = '';
  hasLoaded.value = false;
  isLoading.value = true;

  try {
    await accountSecurity.getSettings();
    selectedOption.value = savedMethod.value;
    hasLoaded.value = true;
  } catch {
    errorMessage.value = 'Could not load Account Security. Your saved settings have not been changed.';
  } finally {
    isLoading.value = false;
  }
}

async function saveSettings() {
  if (!canSave.value) return;

  errorMessage.value = '';
  isSaving.value = true;
  try {
    if (needsMnemonicBackup.value && hasConfirmedBackup.value) {
      config.setCertificationDetails({ hasSavedMnemonic: true });
    }
    await configureAccountSecurity({
      method: selectedOption.value,
      newPasscode: passcode.value,
      currentPasscode: currentPasscode.value,
    });
    passcode.value = '';
    currentPasscode.value = '';
    emit('close');
  } catch (error) {
    console.error('Unable to update Account Security settings.', error);
    hasLoaded.value = false;
    try {
      await accountSecurity.getSettings();
      hasLoaded.value = true;
    } catch (refreshError) {
      console.error('Unable to reload Account Security after the failed update.', refreshError);
    }
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSaving.value = false;
  }
}

function reloadAccount() {
  window.location.reload();
}

Vue.onMounted(() => {
  if (walletKeys.canSign) void loadSettings();
});
Vue.onBeforeUnmount(() => {
  passcode.value = '';
  currentPasscode.value = '';
});
</script>
