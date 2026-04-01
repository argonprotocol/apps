<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :showCloseIcon="false" :showGoBack="!!currentStep" @goBack="backToMain" class="w-7/12">
    <template #title>
      <DialogTitle class="grow pl-3">
        <template v-if="!currentStep">Welcome to {{APP_NAME}}!</template>
        <template v-else-if="currentStep.startsWith('Import')">Import Existing Account</template>
      </DialogTitle>
    </template>
    <div v-if="!currentStep" class="mx-2 pt-5 font-light leading-6">
      <div v-if="IS_OPERATIONS_APP" class="pl-5 pr-10 space-y-3">
        <p>
          This is your home base for mining and vaulting on the Argon network. No prior crypto experience required.
        </p>
        <p>
          <strong class="font-bold">Mining</strong> helps secure the Argon network by maintaining consensus and minting
          new Argons when needed. You earn block rewards by helping keep things running smoothly.
        </p>
        <p>
          <strong class="font-bold">Vaulting</strong> locks Bitcoin into stabilization contracts that keeps Argon's
          price steady. You earn revenue from mining revenue based on the percentage of Argons you're helping stabilize.
        </p>
      </div>
      <div v-else-if="IS_CAPITAL_APP" class="pl-5 pr-10 space-y-3">
        <p>
          Argon is an inflation-resistant, fiat-independent stablecoin and this app lets you access the
          yield-generating instruments underlying it. Savings, bonds, bitcoin locks, and stable swaps are all available,
          each with different risk and return profiles.
        </p>
      </div>

      <div class="border-t border-slate-300 pl-3 pr-5 mx-2 mt-5 pt-5">
        <header class="font-bold">Are You New Here?</header>
        <p class="pt-1 mb-5">
          Admission is by invite only. Paste the Access Code from your invite to get started.
        </p>

        <div
          v-if="formError"
          class="mt-2 flex flex-row items-center gap-x-2 text-red-600 bg-red-100 border border-b-none border-red-400/50 px-3 py-1.5 rounded-t-lg"
        >
          <AlertIcon class="h-4 w-4 shrink-0" />
          <span>{{ formError }}</span>
        </div>

        <input
          v-model="inviteCode"
          type="text"
          placeholder="Access Code"
          class="w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
        />

        <button
          @click="connectToNetwork"
          class="mt-5 flex flex-row w-full justify-center items-center space-x-2 border bg-argon-button border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none"
          tabindex="0"
        >
          Get Started
          <ChevronDoubleRightIcon class="size-5 ml-2 relative text-white" />
        </button>
      </div>

      <div class="border-t border-slate-300 pl-3 pr-5 mx-2 mt-5 pt-5 pb-7">
        <header class="font-bold">Already Have An Account?</header>
        <p class="mt-1">
          Pick up where you left off by importing your existing account.
        </p>

        <button @click="startImportAccount" tabindex="-1" class="mt-5 w-full flex flex-row items-center justify-center space-x-2 bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none">
          Import Existing Account
        </button>
      </div>
    </div>

    <div v-else-if="currentStep.startsWith('Import')" class="mx-2 pt-5 font-light leading-6">
      <div class="pl-5 pr-10">
        <ImportAccountOverview v-if="currentStep === 'Import'" @close="backToMain" @goTo="showImportFrom" class="pb-5" />
        <ImportAccountFromMnemonic
          v-if="currentStep === 'Import:FromMnemonic'"
          ref="importAccountFromMnemonicRef"
          :showButton="false"
          @close="backToMain"
          @goTo="showImportFrom"
        />
      </div>
      <div v-if="currentStep === 'Import:FromMnemonic'" class="flex flex-row items-center justify-between border-t border-slate-300 py-5 px-5 mt-6 space-x-4">
        <button @click="importFromMnemonic" tabindex="0" class="w-full flex flex-row justify-center items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
          Import Account
        </button>
      </div>
    </div>

  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import { getConfig } from '../stores/config';
import { APP_NAME, IS_OPERATIONS_APP, IS_CAPITAL_APP } from '../lib/Env.ts';
import AlertIcon from '../assets/alert.svg?component';
import { BootstrapType } from '../interfaces/IConfig.ts';
import { DialogTitle } from 'reka-ui';
import ImportAccountOverview from './import-account/Overview.vue';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';
import { VaultInvites } from '../lib/VaultInvites.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import type { ICapitalInvite } from '@argonprotocol/apps-router';

const config = getConfig();

const isOpen = Vue.ref(config.showWelcomeOverlay);
const importAccountFromMnemonicRef = Vue.ref<InstanceType<typeof ImportAccountFromMnemonic> | null>(null);

const hasValidInviteCode = Vue.ref(false);
const currentStep = Vue.ref<'Create' | 'Import' | 'Import:FromMnemonic' | null>(null);
const inviteCode = Vue.ref<string>('');
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

async function connectToNetwork() {
  formError.value = '';

  if (!hasValidInviteCode.value) {
    formError.value = 'You must provide a valid access code.';
    return;
  }

  const meta = VaultInvites.decodeInviteCode(inviteCode.value);
  if (meta.hasError || meta.isEmpty) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  const host = `http://${meta.ipAddress}:${meta.port}`;
  let body: { fromName: string; invite: ICapitalInvite };
  try {
    const response = await fetch(`${host}/capital-users/${inviteCode.value}/register-app`, { method: 'POST' });
    if (!response.ok) {
      formError.value = 'Unable to connect with that access code. Please verify it and try again.';
      return;
    }

    const rawBody = await response.text();
    body = JsonExt.parse<{ fromName: string; invite: ICapitalInvite }>(rawBody);
  } catch {
    formError.value = 'Unable to connect with that access code. Please verify it and try again.';
    return;
  }

  if (!body?.fromName || !body.invite?.vaultId) {
    formError.value = 'Unable to connect with that access code. Please verify it and try again.';
    return;
  }

  const invite = body.invite;

  config.upstreamOperator = {
    name: body.fromName,
    vaultId: invite.vaultId,
    inviteCode: inviteCode.value.trim(),
  };

  config.bootstrapDetails = {
    type: BootstrapType.Private,
    routerHost: [meta.ipAddress, meta.port].filter(x => x).join(':'),
  };

  await config.save();
  isOpen.value = false;
}

Vue.watch(inviteCode, () => {
  const decoded = VaultInvites.decodeInviteCode(inviteCode.value);
  formError.value = '';
  hasValidInviteCode.value = true;
  if (decoded.hasError) {
    formError.value = 'The access code you provided is invalid.';
    hasValidInviteCode.value = false;
  }
});
</script>
