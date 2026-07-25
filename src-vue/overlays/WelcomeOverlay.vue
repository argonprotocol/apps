<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :showGoBack="!!currentStep" :enableTopBar="true" @goBack="backToMain" class="w-7/12">
    <template #title>
      <DialogTitle class="grow pl-3">
        <template v-if="currentStep?.startsWith('Import')">Import Existing Account</template>
        <template v-else-if="config.wasImportedFromLegacy">We Successfully Imported Your Operations Account!</template>
        <template v-else>Welcome to Argon Desktop!</template>
      </DialogTitle>
    </template>
    <div v-if="!currentStep" class="mx-2 py-5 font-light leading-6">
      <div class="pl-5 pr-10 space-y-3">
        <p>
          Argon is the world’s first inflation-resistant, fiat-independent stablecoin. This app gives you everything you
          need to deploy assets, invest in the ecosystem and power the network.
        </p>

        <ul class="flex flex-row gap-x-10 py-3">
          <li class="w-1/3 bg-argon-100/30 rounded-md text-center py-3 px-2">
            <div class="flex flex-row gap-x-2 text-argon-400 justify-center">
              <SwapIcon class="h-5" />
            </div>
            <header class="font-bold text-argon-600 my-1.5">1. Save and Move</header>
            <p class="text-md">Hold inflation-resistant money and move it across chains without bridges.</p>
          </li>
          <li class="w-1/3 bg-argon-100/30 rounded-md text-center py-3 px-2">
            <div class="flex flex-row gap-x-2 text-argon-400 justify-center">
              <BitcoinIcon class="h-5" />
              <ArgonIcon class="h-5 opacity-70" />
              <ArgonotIcon class="h-5 opacity-70" />
            </div>
            <header class="font-bold text-argon-600 my-1.5">2. Deploy Capital</header>
            <p>Access bonds, staking, bitcoins locks, and other opportunities.</p>
          </li>
          <li class="w-1/3 bg-argon-100/30 rounded-md text-center py-3 px-2">
            <div class="flex flex-row gap-x-2 text-argon-400 justify-center">
              <MiningIcon class="h-5" />
              <VaultingIcon class="h-5" />
            </div>
            <header class="font-bold text-argon-600 my-1.5">3. Become an Operator</header>
            <p>Operate mining and vaulting infrastructure to keep Argon running.</p>
          </li>
        </ul>

        <p>
          <strong class="font-bold">Remember, you're in control</strong>. This is open-source, self-custody software, meaning you are responsible
          for your keys, backups, and transactions.
          <a
            @click="basicEmitter.emit('openSoftwareInfoOverlay')"
            class="cursor-pointer text-argon-600 hover:underline focus-visible:underline focus:outline-none"
          >
            Learn more about self-custody
          </a>.
        </p>
      </div>

      <div class="mt-6 flex flex-row items-center justify-between space-x-4 border-t border-slate-300 px-5 py-1">
        <button
          v-if="!config.wasImportedFromLegacy"
          @click="startImportAccount"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Import Existing Account
        </button>
        <button
          @click="closeOverlay"
          class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          Start With New Account
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
import MiningIcon from '../assets/mining-oil.svg';
import SwapIcon from '../assets/swap.svg';
import VaultingIcon from '../assets/vault-small.svg';
import BitcoinIcon from '../assets/wallets/bitcoin.svg';
import ArgonIcon from '../assets/wallets/tokens/argon.svg';
import ArgonotIcon from '../assets/wallets/tokens/argonot.svg';

const config = getConfig();

const isBasicApp = !config.hasExtensionTreasury && !config.hasExtensionOperations;
const isOpen = Vue.ref(isBasicApp && config.showWelcomeOverlay);
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
