<template>
  <div class="px-5 pt-4 pb-5 text-slate-700">
    <div class="text-reg mt-4 space-y-3 leading-6 text-slate-500">
      <p>
        Argon Treasury gives you access to yield instruments like Bitcoin Liquid Locks and Argon Bonds.
        <br />
        <br />
        Paste an invite from a Vault operator to participate to begin (if you don't have one, a request on the Argon
        Discord channel can often be a good place to start).
      </p>
    </div>

    <div
      v-if="formError"
      class="mt-4 flex flex-row items-center gap-x-2 rounded-lg border border-red-400/50 bg-red-100 px-3 py-1.5 text-red-600"
    >
      <AlertIcon class="h-4 w-4 shrink-0" />
      <span>{{ formError }}</span>
    </div>

    <input
      v-model="inviteCode"
      type="text"
      placeholder="Paste invite code"
      class="text-md focus:border-argon-500 focus:ring-argon-500/15 mt-5 w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] transition outline-none focus:ring-2"
    />

    <button
      @click="connectToNetwork"
      class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow mt-4 flex w-full cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border px-12 py-2 font-bold text-white focus:outline-none"
      tabindex="0"
    >
      Join Vault
      <ChevronDoubleRightIcon class="relative ml-2 size-5 text-white" />
    </button>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { getConfig } from '../stores/config.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import AlertIcon from '../assets/alert.svg?component';
import { BootstrapType, TopTab } from '../interfaces/IConfig.ts';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';

const emit = defineEmits<{
  (e: 'claimed'): void;
}>();

const config = getConfig();
const controller = useCertificationController();
const walletKeys = getWalletKeys();

const hasValidInviteCode = Vue.ref(false);
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

  const match = parsedUrl.pathname.match(/^\/invite\/([^/?#]+)/);
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
  if (!meta.inviteCode || !meta.host || !meta.port) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  const operatorAddress = [meta.host, meta.port].filter(Boolean).join(':');
  const operatorHost = UpstreamOperatorClient.getBootstrapHost({
    type: BootstrapType.Private,
    routerHost: operatorAddress,
  });
  if (!operatorHost) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  try {
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    const defaultAccountKeypair = await walletKeys.getLiquidLockingKeypair();
    const body = await UpstreamOperatorClient.claimInvite({
      operatorHost,
      inviteCode: meta.inviteCode,
      defaultAccountKeypair,
      authKeypair,
    });

    if (!body?.fromName || !body.invite?.vaultId || !body.invite.bitcoinLockCoupon) {
      throw new Error('Unable to connect with that access code. Please verify it and try again.');
    }

    config.upstreamOperator = {
      ...config.upstreamOperator,
      name: body.fromName,
      vaultId: body.invite.vaultId,
      accountId: body.referrer,
    };
    config.hasExtensionTreasury = true;
    config.showWelcomeOverlay = false;
    config.bootstrapDetails = {
      ...UpstreamOperatorClient.getBootstrapDetails(operatorHost, BootstrapType.Private),
    };

    await config.save();
    controller.setTab(TopTab.Treasury);
  } catch (error) {
    formError.value =
      error instanceof Error && error.message
        ? error.message
        : 'An error occurred trying to connect with that access code. Please verify it and try again.';
    return;
  }

  emit('claimed');
}

Vue.watch(
  inviteCode,
  () => {
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
  },
  { immediate: true },
);
</script>
