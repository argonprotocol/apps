<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :showGoBack="!!currentStep" :enableTopBar="true" @goBack="backToMain" class="w-7/12">
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
        <p>
          This is open-source, self-custody software. You are responsible for your keys, backups, and transactions.
          <button
            @click="basicEmitter.emit('openSoftwareInfoOverlay')"
            class="cursor-pointer text-argon-600 hover:underline focus-visible:underline"
          >
            What this means
          </button>.
        </p>
      </div>

      <div class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-1">
        <button
          @click="startImportAccount"
          tabindex="-1"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Import Existing Account
        </button>
        <button
          @click="closeOverlay"
          tabindex="-1"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Continue
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
      <div class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-5">
        <button
          @click="importFromMnemonic"
          tabindex="0"
          class="w-full flex flex-row items-center justify-center space-x-2 rounded-md border border-argon-button-hover bg-argon-button px-12 py-2 font-bold text-white inner-button-shadow cursor-pointer hover:bg-argon-button-hover focus:outline-none"
        >
          Import Account
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';

const config = getConfig();

const isOpen = Vue.ref(config.showWelcomeOverlay);
const importAccountFromMnemonicRef = Vue.ref<InstanceType<typeof ImportAccountFromMnemonic> | null>(null);

const currentStep = Vue.ref<'Create' | 'Import' | 'Import:FromMnemonic' | null>(null);

function backToMain() {
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

  config.showWelcomeOverlay = false;
  await config.save();
  isOpen.value = false;
}

async function closeOverlay() {
  config.showWelcomeOverlay = false;
  await config.save();
  isOpen.value = false;
}
</script>
