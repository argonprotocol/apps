<template>
  <div class="flex flex-col gap-4">
    <p class="text-sm leading-6 text-slate-600">
      Paste a WalletConnect URI from Coinbase Wallet and connect this treasury wallet using its Ethereum address.
    </p>

    <label class="flex flex-col gap-2">
      <span class="text-sm font-semibold text-slate-700">WalletConnect URI</span>
      <textarea
        v-model.trim="walletConnectUri"
        rows="4"
        spellcheck="false"
        placeholder="wc:..."
        class="focus:border-argon-button focus:ring-argon-button/20 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-sm transition outline-none focus:ring-2" />
    </label>

    <div class="flex items-center gap-3">
      <button
        @click="connectWallet"
        :disabled="isConnecting || !walletConnectUri"
        class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow cursor-pointer rounded-md border px-6 py-2 font-bold text-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-60">
        {{ isConnecting ? 'Connecting...' : 'Connect' }}
      </button>
      <span class="text-xs break-all text-slate-500">Using {{ walletKeys.ethereumAddress }}</span>
    </div>

    <div v-if="activeSessionTopic" class="flex items-center gap-3">
      <button
        @click="disconnectWallet"
        :disabled="isDisconnecting"
        class="cursor-pointer rounded-md border border-slate-300 bg-white px-6 py-2 font-bold text-slate-800 hover:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60">
        {{ isDisconnecting ? 'Disconnecting...' : 'Disconnect' }}
      </button>
      <span class="text-xs break-all text-slate-500">Session {{ activeSessionTopic }}</span>
    </div>

    <p v-if="statusMessage" :class="statusToneClass" class="text-sm leading-6">
      {{ statusMessage }}
    </p>

    <div v-if="hasBaseAlert || baseBalancesError" class="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 class="text-base font-semibold text-amber-900">Base network alert</h3>
      <p v-if="baseBalancesError" class="mt-2 text-sm leading-6 text-red-600">
        {{ baseBalancesError }}
      </p>
      <p v-else class="mt-2 text-sm leading-6 text-amber-900">
        This wallet also has assets on Base:
        {{ baseAlertTokens.map(token => `${token.symbol} ${token.formatted}`).join(', ') }}. Those balances are on a
        different network, so the user may need to bridge or move them if they expected them here.
      </p>
    </div>

    <div class="rounded-lg border border-slate-300 bg-slate-50 p-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-slate-900">Ethereum balances</h3>
          <p class="mt-1 text-sm leading-6 text-slate-600">Static token list for {{ walletKeys.ethereumAddress }}</p>
        </div>
        <button
          @click="loadEthereumBalances"
          :disabled="isLoadingEthereumBalances"
          class="cursor-pointer rounded-md border border-slate-300 bg-white px-4 py-2 font-bold text-slate-800 hover:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60">
          {{ isLoadingEthereumBalances ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>

      <p v-if="ethereumBalancesError" class="mt-3 text-sm leading-6 text-red-600">
        {{ ethereumBalancesError }}
      </p>

      <div class="mt-4 grid gap-3">
        <div
          v-for="token in ethereumBalances"
          :key="token.symbol"
          class="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3">
          <div class="flex flex-col">
            <span class="text-sm font-semibold text-slate-900">{{ token.symbol }}</span>
            <span v-if="token.address" class="font-mono text-xs break-all text-slate-500">{{ token.address }}</span>
            <span v-else class="text-xs text-slate-500">Native Ethereum balance</span>
          </div>
          <span class="font-mono text-sm text-slate-900">{{ token.formatted }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useBasics } from '../../../stores/basics.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { type Address, createPublicClient, erc20Abi, formatUnits, getAddress, http } from 'viem';
import * as Vue from 'vue';
import { base } from 'viem/chains';
import type { ProposalTypes, SignClientTypes } from '@walletconnect/types';
import {
  allowedWalletConnectHosts,
  getTreasuryWalletKit,
  setTreasuryWalletKitHandlers,
  walletConnectChains,
  walletConnectEvents,
  walletConnectMethods,
  walletConnectProjectId,
} from '../../lib/TreasuryWalletConnect.ts';
import { createStableSwapPublicClient } from '../../../lib/StableSwaps.ts';
import type { IWalletKit } from '@reown/walletkit';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import basicEmitter from '../../../emitters/basicEmitter.ts';

const walletKeys = getWalletKeys();
const trackedEthereumTokens = [
  { symbol: 'ETH', decimals: 18, address: null },
  { symbol: 'USDC', decimals: 6, address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') },
  { symbol: 'USDT', decimals: 6, address: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7') },
  { symbol: 'USDE', decimals: 18, address: getAddress('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3') },
] as const;
const trackedBaseTokens = [
  { symbol: 'ETH', decimals: 18, address: null },
  { symbol: 'USDC', decimals: 6, address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
] as const;

const walletConnectUri = Vue.ref('');
const isConnecting = Vue.ref(false);
const isDisconnecting = Vue.ref(false);
const isLoadingEthereumBalances = Vue.ref(false);
const statusMessage = Vue.ref('');
const statusTone = Vue.ref<'idle' | 'error' | 'success'>('idle');
const activeSessionTopic = Vue.ref<string | null>(null);
const ethereumBalancesError = Vue.ref('');
const baseBalancesError = Vue.ref('');
const ethereumBalances = Vue.ref(
  trackedEthereumTokens.map(token => ({
    ...token,
    formatted: '--',
  })),
);
const baseBalances = Vue.ref(
  trackedBaseTokens.map(token => ({
    ...token,
    formatted: '--',
    raw: 0n,
  })),
);

const statusToneClass = Vue.computed(() => {
  if (statusTone.value === 'error') return 'text-red-600';
  if (statusTone.value === 'success') return 'text-emerald-600';
  return 'text-slate-600';
});

const baseAlertTokens = Vue.computed(() => baseBalances.value.filter(token => token.raw > 0n));
const hasBaseAlert = Vue.computed(() => baseAlertTokens.value.length > 0);

function setStatus(message: string, tone: 'idle' | 'error' | 'success' = 'idle') {
  statusMessage.value = message;
  statusTone.value = tone;
}

function createBasePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org', {
      retryCount: 1,
      timeout: 15_000,
    }),
  });
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

async function loadEthereumBalances() {
  isLoadingEthereumBalances.value = true;
  ethereumBalancesError.value = '';
  baseBalancesError.value = '';

  try {
    const client = createStableSwapPublicClient();
    const baseClient = createBasePublicClient();
    const walletAddress = getAddress(walletKeys.ethereumAddress) as Address;

    const [balances, baseTokenBalances] = await Promise.all([
      Promise.all(
        trackedEthereumTokens.map(async token => {
          const rawBalance = token.address
            ? await client.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [walletAddress],
              })
            : await client.getBalance({
                address: walletAddress,
              });

          return {
            ...token,
            formatted: formatUnits(rawBalance, token.decimals),
          };
        }),
      ),
      Promise.all(
        trackedBaseTokens.map(async token => {
          const rawBalance = token.address
            ? await baseClient.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [walletAddress],
              })
            : await baseClient.getBalance({
                address: walletAddress,
              });

          return {
            ...token,
            raw: rawBalance,
            formatted: formatUnits(rawBalance, token.decimals),
          };
        }),
      ),
    ]);

    ethereumBalances.value = balances;
    baseBalances.value = baseTokenBalances;
  } catch (error) {
    ethereumBalancesError.value = error instanceof Error ? error.message : 'Unable to load Ethereum token balances.';
    baseBalancesError.value = error instanceof Error ? error.message : 'Unable to load Base token balances.';
  } finally {
    isLoadingEthereumBalances.value = false;
  }
}

async function hydrateWalletConnectState() {
  if (!walletConnectProjectId) return;

  try {
    const walletKit = await getTreasuryWalletKit();
    const activeSession = Object.values(walletKit.getActiveSessions())[0];
    if (!activeSession) return;

    activeSessionTopic.value = activeSession.topic;
    const peerUrl = activeSession.peer.metadata.url?.trim() || 'WalletConnect peer';
    setStatus(`Connected to ${peerUrl}.`, 'success');
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

  activeSessionTopic.value = Object.keys(walletKit.getActiveSessions())[0] ?? activeSessionTopic.value;
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

async function disconnectWallet() {
  if (!activeSessionTopic.value) return;

  isDisconnecting.value = true;

  try {
    const walletKit = await getTreasuryWalletKit();
    await walletKit.disconnectSession({
      topic: activeSessionTopic.value,
      reason: getSdkError('USER_DISCONNECTED'),
    });
    activeSessionTopic.value = null;
    setStatus('WalletConnect session disconnected.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to disconnect the WalletConnect session.';
    setStatus(message, 'error');
  } finally {
    isDisconnecting.value = false;
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
    setStatus('Connected and approved for wallet.coinbase.com.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect the WalletConnect session.';
    setStatus(message, 'error');
  } finally {
    isConnecting.value = false;
  }
}

Vue.onMounted(() => {
  setStatus('', 'idle');

  setTreasuryWalletKitHandlers({
    onSessionRequest: handleSessionRequest,
    onSessionDelete: () => {
      activeSessionTopic.value = null;
      setStatus('WalletConnect session disconnected.', 'idle');
    },
  });
  void hydrateWalletConnectState();
  void loadEthereumBalances();
});
</script>
