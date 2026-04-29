<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-7/12 overflow-auto">
    <template #title>
      <DialogTitle>Signature Request</DialogTitle>
    </template>

    <div class="px-5 py-4">
      <div v-if="pendingSessionRequest" class="flex flex-col gap-4">
        <div>
          <h3 class="text-base font-semibold text-slate-900">WalletConnect signature request</h3>
          <p class="mt-1 text-sm leading-6 text-slate-600">
            {{ sessionRequestOriginLabel }}
          </p>
        </div>

        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt class="font-semibold text-slate-700">Method</dt>
          <dd class="font-mono text-slate-900">{{ sessionRequestMethod }}</dd>
          <dt class="font-semibold text-slate-700">Chain</dt>
          <dd class="font-mono text-slate-900">{{ sessionRequestChainId }}</dd>
          <dt class="font-semibold text-slate-700">Address</dt>
          <dd class="font-mono text-slate-900 break-all">{{ sessionRequestAddressLabel }}</dd>
        </dl>

        <div v-if="sessionRequestMessagePreview" class="flex flex-col gap-2">
          <span class="text-sm font-semibold text-slate-700">Message</span>
          <pre class="max-h-48 overflow-auto rounded-md border border-slate-300 bg-white p-3 text-xs leading-5 whitespace-pre-wrap break-words text-slate-800">{{ sessionRequestMessagePreview }}</pre>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-sm font-semibold text-slate-700">Raw params</span>
          <pre class="max-h-48 overflow-auto rounded-md border border-slate-300 bg-white p-3 text-xs leading-5 whitespace-pre-wrap break-words text-slate-800">{{ sessionRequestParamsPreview }}</pre>
        </div>

        <p v-if="statusMessage" :class="statusToneClass" class="text-sm leading-6">
          {{ statusMessage }}
        </p>

        <div class="flex items-center gap-3">
          <button
            @click="approveSessionRequest"
            :disabled="isRespondingToRequest"
            class="border bg-argon-button border-argon-button-hover hover:bg-argon-button-hover disabled:cursor-not-allowed disabled:opacity-60 text-white font-bold inner-button-shadow px-6 py-2 rounded-md cursor-pointer focus:outline-none"
          >
            {{ isRespondingToRequest ? 'Responding...' : 'Approve Signature' }}
          </button>
          <button
            @click="rejectSessionRequest"
            :disabled="isRespondingToRequest"
            class="border border-slate-300 bg-white hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 text-slate-800 font-bold px-6 py-2 rounded-md cursor-pointer focus:outline-none"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import { DialogTitle } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useBasics } from '../../stores/basics.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { getSdkError } from '@walletconnect/utils';
import type { SignClientTypes } from '@walletconnect/types';
import type { JsonRpcResponse } from '@walletconnect/jsonrpc-types';
import { getTreasuryWalletKit } from '../lib/TreasuryWalletConnect.ts';

const basics = useBasics();
const walletKeys = getWalletKeys();

const isOpen = Vue.ref(false);
const isRespondingToRequest = Vue.ref(false);
const statusMessage = Vue.ref('');
const statusTone = Vue.ref<'idle' | 'error' | 'success'>('idle');
const pendingSessionRequest = Vue.ref<SignClientTypes.EventArguments['session_request'] | null>(null);

const statusToneClass = Vue.computed(() => {
  if (statusTone.value === 'error') return 'text-red-600';
  if (statusTone.value === 'success') return 'text-emerald-600';
  return 'text-slate-600';
});

const sessionRequestMethod = Vue.computed(() => pendingSessionRequest.value?.params.request.method ?? '--');
const sessionRequestChainId = Vue.computed(() => pendingSessionRequest.value?.params.chainId ?? '--');
const sessionRequestParamsPreview = Vue.computed(() =>
  JSON.stringify(pendingSessionRequest.value?.params.request.params ?? null, null, 2),
);
const sessionRequestOriginLabel = Vue.computed(() => {
  if (!pendingSessionRequest.value) return '';
  const origin = pendingSessionRequest.value.verifyContext?.verified?.origin;
  return origin
    ? `Review the WalletConnect request from ${origin}.`
    : 'Review the incoming WalletConnect signature request.';
});
const sessionRequestAddressLabel = Vue.computed(
  () => getSessionRequestAddress(pendingSessionRequest.value) || '(not provided)',
);
const sessionRequestMessagePreview = Vue.computed(() => {
  const message = getSessionRequestMessage(pendingSessionRequest.value);
  if (!message) return '';
  return decodeWalletMessagePreview(message);
});

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

function setStatus(message: string, tone: 'idle' | 'error' | 'success' = 'idle') {
  statusMessage.value = message;
  statusTone.value = tone;
}

function normalizeWalletAddress(address: string | null | undefined): string {
  return (address || '').trim().toLowerCase();
}

function getSessionRequestAddress(
  sessionRequest: SignClientTypes.EventArguments['session_request'] | null,
): string | null {
  if (!sessionRequest) return null;
  const params = sessionRequest.params.request.params;
  if (!Array.isArray(params)) return null;

  switch (sessionRequest.params.request.method) {
    case 'personal_sign':
      return typeof params[1] === 'string' ? params[1] : null;
    case 'eth_sign':
    case 'eth_signTypedData':
    case 'eth_signTypedData_v4':
      return typeof params[0] === 'string' ? params[0] : null;
    default:
      return typeof params[0] === 'string' && params[0].startsWith('0x') ? params[0] : null;
  }
}

function getSessionRequestMessage(
  sessionRequest: SignClientTypes.EventArguments['session_request'] | null,
): string | null {
  if (!sessionRequest) return null;
  const params = sessionRequest.params.request.params;
  if (!Array.isArray(params)) return null;

  switch (sessionRequest.params.request.method) {
    case 'personal_sign':
      return typeof params[0] === 'string' ? params[0] : null;
    case 'eth_sign':
      return typeof params[1] === 'string' ? params[1] : null;
    default:
      return typeof params[1] === 'string' ? params[1] : null;
  }
}

function decodeWalletMessagePreview(message: string): string {
  if (!message.startsWith('0x')) return message;

  const hex = message.slice(2);
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return message;

  try {
    const bytes = Uint8Array.from(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    const decoded = new TextDecoder().decode(bytes);
    const hasControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
    return hasControlCharacters ? message : decoded;
  } catch {
    return message;
  }
}

async function buildApprovedSessionRequestResponse(
  sessionRequest: SignClientTypes.EventArguments['session_request'],
): Promise<JsonRpcResponse> {
  const { method } = sessionRequest.params.request;
  const requestedAddress = getSessionRequestAddress(sessionRequest);

  if (
    requestedAddress &&
    normalizeWalletAddress(requestedAddress) !== normalizeWalletAddress(walletKeys.ethereumAddress)
  ) {
    throw new Error(
      `WalletConnect asked to sign for ${requestedAddress}, but this wallet controls ${walletKeys.ethereumAddress}.`,
    );
  }

  switch (method) {
    case 'personal_sign':
    case 'eth_sign': {
      const message = getSessionRequestMessage(sessionRequest);
      if (!message) {
        throw new Error(`WalletConnect ${method} request did not include a signable message.`);
      }
      const signature = await walletKeys.signEthereumPersonalMessage(message);
      return {
        id: sessionRequest.id,
        jsonrpc: '2.0',
        result: signature,
      };
    }
    default:
      return {
        id: sessionRequest.id,
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: `Unsupported WalletConnect request method: ${method}`,
        },
      };
  }
}

async function respondToSessionRequest(approve: boolean) {
  const sessionRequest = pendingSessionRequest.value;
  if (!sessionRequest) return;

  isRespondingToRequest.value = true;

  try {
    const walletKit = await getTreasuryWalletKit(walletKeys.ethereumAddress);
    const response = approve
      ? await buildApprovedSessionRequestResponse(sessionRequest)
      : {
          id: sessionRequest.id,
          jsonrpc: '2.0',
          error: getSdkError('USER_REJECTED'),
        };

    await walletKit.respondSessionRequest({
      topic: sessionRequest.topic,
      response,
    });

    pendingSessionRequest.value = null;
    setStatus(
      approve
        ? `Responded to ${sessionRequest.params.request.method}.`
        : `Rejected ${sessionRequest.params.request.method}.`,
      approve ? 'success' : 'idle',
    );
    closeOverlay();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to respond to the WalletConnect request.';
    setStatus(message, 'error');
  } finally {
    isRespondingToRequest.value = false;
  }
}

async function approveSessionRequest() {
  await respondToSessionRequest(true);
}

async function rejectSessionRequest() {
  await respondToSessionRequest(false);
}

basicEmitter.on('openSigningOverlay', sessionRequest => {
  pendingSessionRequest.value = sessionRequest;
  isOpen.value = true;
  basics.overlayIsOpen = true;
  setStatus('', 'idle');
});
</script>
