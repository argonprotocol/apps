<template>
  <div class="mx-2 mt-5 border-t border-slate-300 pt-5 pr-5 pl-3">
    <header class="font-bold">Are You New Here?</header>
    <p class="mb-5 pt-1">Admission is by invite only. Paste the Access Code from your invite to get started.</p>

    <div
      v-if="formError"
      class="border-b-none mt-2 flex flex-row items-center gap-x-2 rounded-t-lg border border-red-400/50 bg-red-100 px-3 py-1.5 text-red-600"
    >
      <AlertIcon class="h-4 w-4 shrink-0" />
      <span>{{ formError }}</span>
    </div>

    <input
      v-model="inviteCode"
      type="text"
      placeholder="Access Code"
      class="focus:border-argon-500 focus:ring-argon-500/15 w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] transition outline-none focus:ring-2"
    />

    <button
      @click="connectToNetwork"
      class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow mt-5 flex w-full cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border px-12 py-2 font-bold text-white focus:outline-none"
      tabindex="0"
    >
      Get Started
      <ChevronDoubleRightIcon class="relative ml-2 size-5 text-white" />
    </button>
  </div>

  <div class="mx-2 mt-5 border-t border-slate-300 pt-5 pr-5 pb-7 pl-3">
    <header class="font-bold">Already Have An Account?</header>
    <p class="mt-1">Pick up where you left off by importing your existing account.</p>

    <button
      @click="startImportAccount"
      tabindex="-1"
      class="border-argon-600/50 hover:bg-argon-600/10 text-argon-600 inner-button-shadow mt-5 flex w-full cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border bg-white px-6 py-2 font-bold focus:outline-none"
    >
      Import Existing Account
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { UserRole } from '@argonprotocol/apps-core';
import { DialogTitle } from 'reka-ui';
import OverlayBase from './OverlayBase.vue';
import { getConfig } from '../stores/config.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { APP_NAME, IS_OPERATIONS_APP, IS_TREASURY_APP } from '../lib/Env.ts';
import AlertIcon from '../assets/alert.svg?component';
import { BootstrapType } from '../interfaces/IConfig.ts';
import type { IOperationalReferral } from '../interfaces/IConfig.ts';
import ImportAccountFromMnemonic from './import-account/FromMnemonic.vue';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';
import type { IOperationalUserInvite, ITreasuryUserInvite } from '@argonprotocol/apps-router';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';

const config = getConfig();
const walletKeys = getWalletKeys();

const isOpen = Vue.ref(config.showWelcomeOverlay);
const importAccountFromMnemonicRef = Vue.ref<InstanceType<typeof ImportAccountFromMnemonic> | null>(null);

const hasValidInviteCode = Vue.ref(false);
const currentStep = Vue.ref<'Create' | 'Import' | 'Import:FromMnemonic' | null>(null);
const inviteCode = Vue.ref<string>('');
const formError = Vue.ref('');

function extractInviteCodeFromUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const match = parsedUrl.pathname.match(/^\/(?:treasury|operational)-invite\/([^/?#]+)/);
  if (!match?.[1]) return trimmed;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

if (typeof window !== 'undefined') {
  const inviteFromPageUrl = extractInviteCodeFromUrl(window.location.href);
  if (inviteFromPageUrl !== window.location.href.trim()) {
    inviteCode.value = inviteFromPageUrl;
  }
}

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

  const meta = InviteEnvelope.decode(inviteCode.value);
  if (meta.hasError || meta.isEmpty) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  const operatorAddress = [meta.host, meta.port].filter(Boolean).join(':');
  const operatorHost = `https://${operatorAddress}`;

  try {
    if (IS_TREASURY_APP) {
      if (meta.role !== UserRole.TreasuryUser || !meta.secret) {
        throw new Error('This access code is for the Operations app.');
      }

      const body = await UpstreamOperatorClient.claimTreasuryAppInvite(operatorHost, meta.secret, walletKeys);
      await connectTreasuryInvite(body, operatorHost, meta.secret);
    } else if (IS_OPERATIONS_APP) {
      if (meta.role !== UserRole.OperationalPartner || !meta.secret || !meta.operationalReferral) {
        throw new Error('This access code is for the Treasury app.');
      }

      const body = await UpstreamOperatorClient.claimOperationalInvite(
        operatorHost,
        meta.secret,
        meta.operationalReferral,
        walletKeys,
      );
      await connectOperationalInvite(body, operatorHost, {
        inviteSecret: meta.secret,
        operationalReferral: meta.operationalReferral,
      });
    }
  } catch (error) {
    formError.value =
      error instanceof Error && error.message
        ? error.message
        : 'An error occurred trying to connect with that access code. Please verify it and try again.';
    return;
  }

  isOpen.value = false;
}

Vue.watch(inviteCode, () => {
  const normalizedInviteCode = extractInviteCodeFromUrl(inviteCode.value);
  if (normalizedInviteCode !== inviteCode.value) {
    inviteCode.value = normalizedInviteCode;
    return;
  }

  const decoded = InviteEnvelope.decode(normalizedInviteCode);
  formError.value = '';
  hasValidInviteCode.value = true;
  if (decoded.hasError) {
    formError.value = 'The access code you provided is invalid.';
    hasValidInviteCode.value = false;
  }
});

async function connectTreasuryInvite(
  body: { fromName: string; invite: ITreasuryUserInvite },
  operatorHost: string,
  inviteSecret: string,
) {
  if (!body?.fromName || !body.invite?.vaultId || !body.invite.bitcoinLockCoupon) {
    throw new Error('Unable to connect with that access code. Please verify it and try again.');
  }

  config.upstreamOperator = {
    ...config.upstreamOperator,
    name: body.fromName,
    vaultId: body.invite.vaultId,
    inviteSecret,
  };
  config.bootstrapDetails = {
    ...UpstreamOperatorClient.getBootstrapDetails(operatorHost, BootstrapType.Private),
  };

  await config.save();
}

async function connectOperationalInvite(
  body: { fromName: string; invite: IOperationalUserInvite },
  operatorHost: string,
  invite: { inviteSecret: string; operationalReferral: IOperationalReferral },
) {
  if (!body?.fromName) {
    throw new Error('Unable to connect with that access code. Please verify it and try again.');
  }

  config.upstreamOperator = {
    ...config.upstreamOperator,
    name: body.fromName,
    inviteSecret: invite.inviteSecret,
    operationalReferral: invite.operationalReferral,
    accountId: body.invite.accountId ?? walletKeys.operationalAddress,
  };
  config.bootstrapDetails = {
    ...UpstreamOperatorClient.getBootstrapDetails(operatorHost, BootstrapType.Private),
  };

  await config.save();
}
</script>
