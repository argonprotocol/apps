<template>
  <div ref="rootRef" class="pointer-events-auto relative" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        NotDraggable
        class="relative flex h-[34px] w-[34px] flex-row items-center justify-center rounded-md border border-slate-400/60 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
        :class="{ 'bg-slate-400/10': isOpen }"
      >
        <ConnectIcon class="pointer-events-none h-5 w-5 text-slate-400" />
        <span
          v-if="connectedSites.length"
          class="bg-argon-500 absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold text-white ring-2 ring-white"
        >
          {{ connectedSites.length }}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="0"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-[2000] data-[state=open]:transition-all"
        >
          <div
            class="bg-argon-menu-bg flex w-[420px] shrink flex-col gap-3 rounded p-4 text-sm text-gray-900 shadow-lg ring-1 ring-gray-900/20"
          >
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">Connected sites</span>
              </div>

              <div v-if="connectedSites.length" class="flex flex-col gap-2 border-b border-slate-200">
                <div
                  v-for="site in connectedSites"
                  :key="site.topic"
                  class="flex min-w-0 items-center justify-between gap-3 border-t border-slate-200 py-2"
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="bg-argon-500 h-2 w-2 shrink-0 rounded-full"></span>
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-semibold text-slate-800">{{ site.name }}</span>
                      <span class="block truncate text-xs text-slate-500">{{ site.host }}</span>
                    </span>
                  </div>
                  <button
                    @click="disconnectWallet(site.topic)"
                    :disabled="disconnectingSessionTopic === site.topic"
                    :aria-label="`Disconnect ${site.name}`"
                    class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XMarkIcon class="h-4 w-4" />
                  </button>
                </div>
              </div>

              <p v-else class="text-xs leading-5 text-slate-500">No sites connected.</p>
            </div>

            <label class="flex flex-col gap-2">
              <span class="text-sm font-semibold text-slate-700">Connect another website:</span>
              <textarea
                v-model.trim="walletConnectUri"
                rows="4"
                spellcheck="false"
                placeholder="wc:..."
                class="focus:border-argon-button focus:ring-argon-button/20 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-sm transition outline-none focus:ring-2"
              />
            </label>

            <div class="flex items-center gap-3">
              <button
                @click="connectWallet"
                :disabled="isConnecting || !walletConnectUri"
                class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow cursor-pointer rounded-md border px-6 py-2 font-bold text-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {{ isConnecting ? 'Connecting...' : 'Connect' }}
              </button>
            </div>

            <p v-if="statusMessage" :class="statusToneClass" class="text-sm leading-6">
              {{ statusMessage }}
            </p>
          </div>
          <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types';
import type { IWalletKit } from '@reown/walletkit';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  type PointerDownOutsideEvent,
} from 'reka-ui';
import ConnectIcon from '../../../assets/connect.svg';
import basicEmitter from '../../../emitters/basicEmitter.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';
import {
  allowedWalletConnectHosts,
  getTreasuryWalletKit,
  setTreasuryWalletKitHandlers,
  walletConnectChains,
  walletConnectEvents,
  walletConnectMethods,
  walletConnectProjectId,
} from '../../lib/TreasuryWalletConnect.ts';

const walletKeys = getWalletKeys();
const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();
const walletConnectUri = Vue.ref('');
const isConnecting = Vue.ref(false);
const disconnectingSessionTopic = Vue.ref<string | null>(null);
const statusMessage = Vue.ref('');
const statusTone = Vue.ref<'idle' | 'error' | 'success'>('idle');
const activeSessions = Vue.ref<SessionTypes.Struct[]>([]);

const statusToneClass = Vue.computed(() => {
  if (statusTone.value === 'error') return 'text-red-600';
  if (statusTone.value === 'success') return 'text-emerald-600';
  return 'text-slate-600';
});

const connectedSites = Vue.computed(() =>
  activeSessions.value
    .map(session => {
      const metadata = session.peer.metadata;
      const url = metadata.url?.trim() || '';
      return {
        topic: session.topic,
        name: metadata.name?.trim() || getHostLabel(url) || 'WalletConnect site',
        host: getHostLabel(url) || url || 'Unknown site',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name)),
);

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function setStatus(message: string, tone: 'idle' | 'error' | 'success' = 'idle') {
  statusMessage.value = message;
  statusTone.value = tone;
}

function normalizeProposalUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function isCoinbaseWalletProposal(proposal: ProposalTypes.Struct): boolean {
  const metadataUrl = proposal.proposer.metadata.url?.trim();
  if (!metadataUrl) return false;

  try {
    const hostname = new URL(normalizeProposalUrl(metadataUrl)).hostname;
    return allowedWalletConnectHosts.some(
      allowedHost => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
    );
  } catch {
    return false;
  }
}

function getProposalUrl(proposal: ProposalTypes.Struct): string {
  return proposal.proposer.metadata.url?.trim() || '(missing proposer url)';
}

function getHostLabel(url: string): string {
  if (!url) return '';

  try {
    return new URL(normalizeProposalUrl(url)).hostname;
  } catch {
    return url;
  }
}

function syncActiveSessions(walletKit: IWalletKit) {
  activeSessions.value = Object.values(walletKit.getActiveSessions());
}

async function refreshActiveSessions() {
  if (!walletConnectProjectId) return;

  try {
    const walletKit = await getTreasuryWalletKit();
    syncActiveSessions(walletKit);
  } catch (error) {
    console.warn('Unable to hydrate WalletConnect session state', error);
  }
}

async function approveCoinbaseProposal(walletKit: IWalletKit, proposal: ProposalTypes.Struct) {
  if (!isCoinbaseWalletProposal(proposal)) {
    await walletKit.rejectSession({
      id: proposal.id,
      reason: getSdkError('USER_REJECTED_METHODS'),
    });
    throw new Error(
      `Rejected WalletConnect proposal from ${getProposalUrl(proposal)}. Allowed sites: ${allowedWalletConnectHosts.join(', ')}.`,
    );
  }

  const namespaces = buildApprovedNamespaces({
    proposal,
    supportedNamespaces: {
      eip155: {
        chains: walletConnectChains,
        methods: walletConnectMethods,
        events: walletConnectEvents,
        accounts: walletConnectChains.map(chain => `${chain}:${walletKeys.ethereumAddress}`),
      },
    },
  });

  await walletKit.approveSession({
    id: proposal.id,
    namespaces,
  });

  syncActiveSessions(walletKit);
}

async function waitForProposal(walletKit: IWalletKit): Promise<ProposalTypes.Struct> {
  const pendingProposal = walletKit.getPendingSessionProposals()[0];
  if (pendingProposal) {
    return pendingProposal;
  }

  return await new Promise<ProposalTypes.Struct>((resolve, reject) => {
    let settled = false;

    const handleProposal = (event: SignClientTypes.EventArguments['session_proposal']) => {
      settled = true;
      clearTimeout(timeout);
      resolve(event.params);
    };

    const timeout = window.setTimeout(() => {
      if (settled) return;
      walletKit.off('session_proposal', handleProposal);
      reject(new Error('Timed out waiting for WalletConnect to send a session proposal.'));
    }, 30_000);

    walletKit.once('session_proposal', handleProposal);
  });
}

function handleSessionRequest(event: SignClientTypes.EventArguments['session_request']) {
  setStatus(`Received ${event.params.request.method} request.`, 'idle');
  basicEmitter.emit('openSigningOverlay', event);
}

async function disconnectWallet(topic: string) {
  if (!topic) return;

  disconnectingSessionTopic.value = topic;

  try {
    const walletKit = await getTreasuryWalletKit();
    await walletKit.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });
    syncActiveSessions(walletKit);
    setStatus('WalletConnect session disconnected.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to disconnect the WalletConnect session.';
    setStatus(message, 'error');
  } finally {
    disconnectingSessionTopic.value = null;
  }
}

async function connectWallet() {
  if (!walletConnectProjectId) {
    setStatus('Set VITE_WALLETCONNECT_PROJECT_ID before using WalletConnect in this overlay.', 'error');
    return;
  }

  const uri = walletConnectUri.value.trim();
  if (!uri.startsWith('wc:')) {
    setStatus('Paste a valid WalletConnect URI starting with wc:.', 'error');
    return;
  }

  isConnecting.value = true;
  setStatus('Waiting for a WalletConnect session proposal...', 'idle');

  try {
    const walletKit = await getTreasuryWalletKit();
    const proposalPromise = waitForProposal(walletKit);

    await walletKit.pair({ uri });
    const proposal = await proposalPromise;
    setStatus(`Received WalletConnect proposal from ${getProposalUrl(proposal)}.`, 'idle');
    await approveCoinbaseProposal(walletKit, proposal);
    const connectedSite = connectedSites.value.find(site => site.topic === activeSessions.value.at(-1)?.topic);
    setStatus(`Connected${connectedSite ? ` to ${connectedSite.host}` : ''}.`, 'success');
    walletConnectUri.value = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect the WalletConnect session.';
    setStatus(message, 'error');
  } finally {
    isConnecting.value = false;
  }
}

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  isOpen.value = true;
}

function onMouseLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
  }, 250);
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}

Vue.onMounted(() => {
  setStatus('', 'idle');

  setTreasuryWalletKitHandlers({
    onSessionRequest: handleSessionRequest,
    onSessionDelete: () => {
      void refreshActiveSessions();
      setStatus('WalletConnect session disconnected.', 'idle');
    },
  });
  void refreshActiveSessions();
});
</script>
