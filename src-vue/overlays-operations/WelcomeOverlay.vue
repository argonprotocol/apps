<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :showGoBack="!!currentStep" @goBack="backToMain" class="w-7/12">
    <template #title>
      <DialogTitle class="grow">
        <template v-if="!currentStep">Welcome to {{APP_NAME}}!</template>
        <template v-else-if="currentStep === 'Create'">Bootstrap Using Existing Node</template>
        <template v-else-if="currentStep.startsWith('Import')">Import Existing Account</template>
      </DialogTitle>
    </template>
    <div v-if="!currentStep" class="mx-2 pt-5 font-light leading-6">
      <div class="pl-5 pr-10 space-y-3">
        <p>
          This app is your home base for the operational side of Argon, a global
          currency that's designed to be a truly stable stablecoin (no inflation, no fiat, no
          centralized entities). Everything you need to run mining seats and manage stabilization
          vaults is right here. No prior crypto experience required.
        </p>
        <p>
          <strong class="font-bold">Mining</strong> helps secure the Argon network by maintaining consensus and printing
          new Argons when needed. Miners earn block rewards for keeping things running smoothly.
        </p>

        <p>
          <strong class="font-bold">Vaulting</strong> locks Bitcoin into stabilization contracts that help keep Argon's
          price steady. In return, you earn revenue from mining bids.
        </p>

        <p>
          Whether you're here to mine, vault, or both, getting started only takes a few clicks.
        </p>
      </div>

      <div class="flex flex-row items-center justify-end border-t border-slate-300 py-5 px-5 mt-12 space-x-4">
        <button @click="startImportAccount" tabindex="-1" class="w-1/2 flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none">
          Import Existing Account
        </button>
        <button @click="startCreateAccount" tabindex="0" class="flex flex-row w-1/2 justify-center items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
          Let's Get Started
          <ChevronDoubleRightIcon class="size-5 ml-2 relative text-white" />
        </button>
      </div>
    </div>

    <div v-else-if="currentStep === 'Create'" class="mx-2 pt-5 font-light leading-6">
      <div class="pl-5 pr-10">
        <p>
          In order to bootstrap into the network, you must connect to an existing node to pull the required data.
          We recommend using a Sponsored Node, which is the most secure.
        </p>

        <div class="flex flex-row justify-end relative mt-10">
          <RocketIcon class="w-10 -rotate-45 text-argon-600 absolute left-20 top-1.5" />
          <div class="grow relative">
            <div class="absolute top-1/2 translate-y-[-44%] w-full">
              <div class="h-2 bg-slate-600/10 w-[104%]" />
              <ul class="flex flex-row items-stretch gap-x-4 border-b border-slate-600/15 py-2 font-bold">
                <li
                  @click="setType(BootstrapType.Private)"
                  :class="[bootstrapType === BootstrapType.Public ? 'text-argon-800 opacity-30 hover:opacity-50' : '']"
                  class="cursor-pointer"
                >
                  Sponsored Node
                </li>
                <li class="w-px bg-slate-600/20"></li>
                <li
                  @click="setType(BootstrapType.Public)"
                  :class="[bootstrapType === BootstrapType.Private ? 'text-argon-800 opacity-30 hover:opacity-50' : '']"
                  class="cursor-pointer"
                >
                  Public Node
                </li>
              </ul>
            </div>
          </div>
          <PlanetIcon class="w-48 text-slate-600/10" />
        </div>

        <div
          v-if="formError"
          class="mb-5 flex flex-row items-center gap-x-2 text-red-600"
        >
          <AlertIcon class="h-4 w-4 shrink-0" />
          <span>{{ formError }}</span>
        </div>

        <label class="block font-bold opacity-40">IP Address or Domain</label>
        <input
          v-model="ipAddress"
          type="text"
          class="w-7/12 rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
        />

        <template v-if="bootstrapType === BootstrapType.Private">
          <label class="block pt-2 font-bold opacity-40 mt-3">Access Key</label>
          <input
            v-model="accessKey"
            type="text"
            class="w-10/12 rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
          />
        </template>
      </div>

      <div class="flex flex-row items-center justify-between border-t border-slate-300 py-5 px-5 mt-14 space-x-4">
        <button @click="backToMain" tabindex="-1" class="w-1/2 flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none">
          <ChevronDoubleLeftIcon class="size-5 mr-2" />
          Back to Previous
        </button>
        <button @click="connectToNetwork" tabindex="0" class="w-1/2 flex flex-row justify-center items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
          Connect to Network
        </button>
      </div>
    </div>

    <div v-else-if="currentStep.startsWith('Import')" class="mx-2 pt-5 font-light leading-6">
      <div class="pl-5 pr-10">
        <ImportAccountOverview v-if="currentStep === 'Import'" @close="backToMain" @goTo="showImportFrom" />
        <ImportAccountFromMnemonic
          v-if="currentStep === 'Import:FromMnemonic'"
          ref="importAccountFromMnemonicRef"
          :showButton="false"
          @close="backToMain"
          @goTo="showImportFrom"
        />
      </div>
      <div class="flex flex-row items-center justify-between border-t border-slate-300 py-5 px-5 mt-6 space-x-4">
        <button
          v-if="currentStep === 'Import'"
          @click="backToMain"
          tabindex="-1"
          class="w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
        >
          <ChevronDoubleLeftIcon class="size-5 mr-2" />
          Back to Previous
        </button>
        <template v-else-if="currentStep === 'Import:FromMnemonic'">
          <button
            @click="backToImportOverview"
            tabindex="-1"
            class="w-1/2 flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
          >
            <ChevronDoubleLeftIcon class="size-5 mr-2" />
            Back to Previous
          </button>
          <button @click="importFromMnemonic" tabindex="0" class="w-1/2 flex flex-row justify-center items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
            Import Account
          </button>
        </template>
      </div>
    </div>

  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import { getConfig } from '../stores/config';
import { APP_NAME } from '../lib/Env.ts';
import PlanetIcon from '../assets/planet.svg?component';
import RocketIcon from '../assets/rocket.svg?component';
import AlertIcon from '../assets/alert.svg?component';
import { BootstrapType } from '../interfaces/IConfig.ts';
import { DialogTitle } from 'reka-ui';
import ImportAccountOverview from './import-account/Overview.vue';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';

const config = getConfig();

const isOpen = Vue.ref(config.showWelcomeOverlay);
const importAccountFromMnemonicRef = Vue.ref<InstanceType<typeof ImportAccountFromMnemonic> | null>(null);

const currentStep = Vue.ref<'Create' | 'Import' | 'Import:FromMnemonic' | null>(null);
const bootstrapType = Vue.ref<BootstrapType>(BootstrapType.Private);
const ipAddress = Vue.ref<string>('');
const accessKey = Vue.ref<string>('');
const formError = Vue.ref('');

function normalizeBootstrapHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    return url.host;
  } catch {
    return trimmed.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
}

function isValidAccessKey(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function backToMain() {
  formError.value = '';
  currentStep.value = null;
}

function startCreateAccount() {
  currentStep.value = 'Create';
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

function backToImportOverview() {
  showImportFrom();
}

async function importFromMnemonic() {
  const didImport = await importAccountFromMnemonicRef.value?.importAccount();
  if (!didImport) return;

  isOpen.value = false;
}

function setType(type: BootstrapType) {
  formError.value = '';
  bootstrapType.value = type;
}

async function connectToNetwork() {
  formError.value = '';
  const normalizedIpAddress = normalizeBootstrapHost(ipAddress.value);

  if (!normalizedIpAddress) {
    formError.value = 'You must provide a valid IP Address';
    return;
  }

  if (bootstrapType.value === BootstrapType.Private && !isValidAccessKey(accessKey.value)) {
    formError.value = 'Access key must be a 32-byte hex string starting with 0x.';
    return;
  }

  config.bootstrapDetails =
    bootstrapType.value === BootstrapType.Private
      ? {
          type: BootstrapType.Private,
          ipAddress: normalizedIpAddress,
          accessCode: accessKey.value.trim(),
        }
      : {
          type: BootstrapType.Public,
          ipAddress: normalizedIpAddress,
        };

  await config.save();
  ipAddress.value = normalizedIpAddress;
  isOpen.value = false;
}

Vue.watch([ipAddress, accessKey], () => {
  formError.value = '';
});
</script>
