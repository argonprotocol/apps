<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :showGoBack="!!currentStep" @goBack="backToMain" class="w-7/12">
    <template #title>
      <DialogTitle class="grow pl-3">
        <template v-if="!currentStep">Welcome to Argon Desktop!</template>
        <template v-else-if="currentStep.startsWith('Import')">Import Existing Account</template>
      </DialogTitle>
    </template>
    <div v-if="!currentStep" class="mx-2 py-5 font-light leading-6">
      <div class="pl-5 pr-10 space-y-3">
        <p>
          Argon is an inflation-resistant, fiat-independent stablecoin and this app lets you access the
          yield-generating instruments underlying it. Savings, bonds, bitcoin locks, and stable swaps are all available,
          each with different risk and return profiles.
        </p>
      </div>

      <div class="flex flex-row items-center justify-between border-t border-slate-300 py-1 px-5 mt-6 space-x-4">
        <button @click="startImportAccount" tabindex="-1" class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none">
          Import Existing Account
        </button>
        <button @click="closeOverlay" tabindex="-1" class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none">
          Close Overlay
        </button>
      </div>
    </div>

    <div v-else-if="currentStep.startsWith('Import')" class="mx-2 pt-5 font-light leading-6">
      <div class="pl-5 pr-10">
        <ImportAccountFromMnemonic
          ref="importAccountFromMnemonicRef"
          :showButton="false"
          @close="backToMain"
          @goTo="showImportFrom"
        />
      </div>
      <div  class="flex flex-row items-center justify-between border-t border-slate-300 py-5 px-5 mt-6 space-x-4">
        <button @click="importFromMnemonic" tabindex="0" class="w-full flex flex-row justify-center items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
          Import Account
        </button>
      </div>
    </div>

  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';
import { APP_NAME } from '../lib/Env.ts';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';

const config = getConfig();

const isOpen = Vue.ref(config.showWelcomeOverlay);
const importAccountFromMnemonicRef = Vue.ref<InstanceType<typeof ImportAccountFromMnemonic> | null>(null);

const currentStep = Vue.ref<'Create' | 'Import' | 'Import:FromMnemonic' | null>(null);
const formError = Vue.ref('');

function backToMain() {
  formError.value = '';
  currentStep.value = null;
}

function startImportAccount() {
  currentStep.value = 'Import';
}

function showImportFrom(name?: string) {
  if (name === 'import-from-mnemonic') {
    currentStep.value = 'Import:FromMnemonic';
  } else {
    currentStep.value = 'Import';
  }
}

async function importFromMnemonic() {
  const didImport = await importAccountFromMnemonicRef.value?.importAccount();
  if (!didImport) return;

  isOpen.value = false;
}

async function closeOverlay() {
  config.showWelcomeOverlay = false;
  void config.save();
}
</script>
