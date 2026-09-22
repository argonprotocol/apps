<template>
  <div class="pointer-events-auto absolute right-2 bottom-2 left-2 rounded-full bg-white">
    <div class="border-argon-900 bg-argon-900/20 flex h-12 flex-row items-center rounded-full border px-5">
      <DropdownMenuRoot v-model:open="isOpen">
        <DropdownMenuTrigger asChild :disabled="pendingTransfers.length === 0">
          <button
            type="button"
            class="text-md flex grow cursor-pointer items-center gap-x-2 text-left focus:outline-none disabled:cursor-default"
          >
            <span v-if="isLoadingTransfers">Loading transfers...</span>
            <span v-else-if="loadError && pendingTransfers.length === 0">Transfer status unavailable</span>
            <span v-else-if="failedTransferCount">
              {{ failedTransferCount }} {{ failedTransferCount === 1 ? 'Transfer' : 'Transfers' }} Needs Attention
              <template v-if="activeTransferCount">
                · {{ activeTransferCount }} {{ activeTransferCount === 1 ? 'Transfer' : 'Transfers' }} Pending
              </template>
            </span>
            <span v-else>
              {{ pendingTransfers.length }}
              {{ pendingTransfers.length === 1 ? 'Transfer' : 'Transfers' }} Pending
            </span>
            <ChevronUpIcon
              v-if="pendingTransfers.length > 0"
              class="h-4 w-4 transition-transform"
              :class="{ 'rotate-180': !isOpen }"
            />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuPortal>
          <DropdownMenuContent
            side="top"
            align="start"
            :alignOffset="-40"
            :sideOffset="5"
            :collisionPadding="10"
            :style="floatingZIndex"
            class="data-[state=open]:animate-slideUpAndFade"
            @closeAutoFocus="$event.preventDefault()"
          >
            <div
              class="max-h-[420px] w-[520px] overflow-y-auto rounded-lg bg-white px-5 py-2 text-sm text-gray-700 shadow-2xl ring-1 ring-gray-900/20"
            >
              <article
                v-for="(transfer, index) in pendingTransfers"
                :key="`${transfer.direction}:${transfer.id}`"
                class="py-4"
                :class="{ 'border-t border-slate-200': index > 0 }"
              >
                <div class="font-semibold text-slate-800">
                  {{ formatAmount(transfer.amount, transfer.moveToken) }} {{ transfer.moveToken }} from
                  {{ transfer.fromLabel }} to {{ transfer.toLabel }}
                </div>
                <div class="mt-0.5 truncate text-xs text-slate-500">
                  Started {{ formatStartedAt(transfer.startedAt) }} ·
                  {{ transfer.progress.detail || transfer.progress.stepLabel }}
                </div>
                <ProgressBar
                  :progress="transfer.progress.progressPct"
                  :hasError="!!transfer.progress.error"
                  :showLabel="false"
                  class="mt-3 h-4"
                />
                <div v-if="transfer.progress.hint" class="mt-1 text-xs text-slate-500">
                  {{ transfer.progress.hint }}
                </div>
                <div v-if="transfer.progress.error" class="mt-1 text-xs text-amber-700">
                  {{ transfer.progress.error }}
                </div>
              </article>
              <div v-if="loadError" class="border-t border-slate-200 py-3 text-xs text-amber-700">
                Some transfer status could not be loaded. {{ loadError }}
              </div>
            </div>
            <DropdownMenuArrow :width="22" :height="12" class="fill-white stroke-gray-300" />
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <div>
        <button
          v-if="loadError"
          type="button"
          class="mr-4 cursor-pointer font-semibold underline"
          :disabled="isLoadingTransfers"
          @click="loadPendingTransfers"
        >
          {{ isLoadingTransfers ? 'Retrying...' : 'Retry' }}
        </button>
        <a :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers`" target="_blank">
          Learn how transfers work --&gt;
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
import { ChevronUpIcon } from '@heroicons/vue/24/outline';
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import ProgressBar from '../../components/ProgressBar.vue';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { getEthereumWalletDisplayName } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getBitcoinReleaseProgress } from '../../stores/bitcoinLockProgress.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getEthereumMoveTracker } from '../../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { useWallets } from '../../stores/wallets.ts';
import {
  getCrosschainTransferProgressView,
  isCrosschainTransferActive,
  type ITransferProgressView,
} from './crosschainTransferView.ts';

type PendingTransfer = {
  id: string;
  direction: 'inbound' | 'outbound';
  moveToken: MoveToken;
  amount: bigint;
  fromLabel: string;
  toLabel: string;
  startedAt: number;
  updatedAt: number;
  progress: ITransferProgressView;
};

const wallets = useWallets();
const bitcoinLocks = getBitcoinLocks();
const { bitcoinLockRelease } = getBitcoinTransactionOperations();
const config = getConfig();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();
const inboundTracker = getEthereumMoveTracker();
const outboundTracker = getEthereumOutboundTransferTracker();
const { microgonToArgonNm, micronotToArgonotNm, satToBtcNm } = createNumeralHelpers(getCurrency());
const floatingZIndex = useFloatingZIndex(2);
const isOpen = Vue.ref(false);
const isLoadingTransfers = Vue.ref(true);
const loadError = Vue.ref('');
const progressNow = Vue.ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;

const pendingTransfers = Vue.computed<PendingTransfer[]>(() => {
  const inboundTransfers = Object.values(inboundTracker.data.transfersById)
    .filter(transfer => isCrosschainTransferActive(transfer.transferState))
    .map<PendingTransfer>(transfer => {
      const ethereumAddress = transfer.persistedRecord?.sourceAddress ?? transfer.sourceAddress ?? '';
      return {
        id: transfer.id,
        direction: 'inbound',
        moveToken: transfer.moveToken,
        amount: transfer.transferState.amount,
        fromLabel: getEthereumWalletLabel(ethereumAddress),
        toLabel: 'Internal App Wallet',
        startedAt: transfer.persistedRecord?.createdAt.getTime() ?? transfer.startedAt ?? 0,
        updatedAt: transfer.persistedRecord?.updatedAt.getTime() ?? transfer.startedAt ?? 0,
        progress: getCrosschainTransferProgressView(transfer.transferState, progressNow.value),
      };
    });
  const outboundTransfers = Object.values(outboundTracker.data.transfersById)
    .filter(transfer => isCrosschainTransferActive(transfer.transferState))
    .map<PendingTransfer>(transfer => {
      const ethereumAddress = transfer.persistedRecord?.destinationAddress ?? transfer.destinationAddress ?? '';
      return {
        id: transfer.id,
        direction: 'outbound',
        moveToken: transfer.moveToken,
        amount: transfer.transferState.amount ?? 0n,
        fromLabel: 'Internal App Wallet',
        toLabel: getEthereumWalletLabel(ethereumAddress),
        startedAt: transfer.persistedRecord?.createdAt.getTime() ?? transfer.startedAt ?? 0,
        updatedAt: transfer.persistedRecord?.updatedAt.getTime() ?? transfer.startedAt ?? 0,
        progress: getCrosschainTransferProgressView(transfer.transferState, progressNow.value),
      };
    });

  const bitcoinChannelFundings = wallets.bitcoinWallet.getPendingInboundUtxos().flatMap<PendingTransfer>(utxo => {
    const channel = bitcoinLocks.getLockById(utxo.lockId);
    if (!channel) return [];

    const progress = bitcoinLocks.utxoTracking.getFundingUtxoProcessingDetails(utxo);
    let detail = 'Bitcoin funding detected.';
    if (progress.confirmations < 0) {
      detail = 'Detected in the Bitcoin mempool. Waiting for the first confirmation...';
    } else if (progress.expectedConfirmations > 0) {
      detail = `Bitcoin confirmation ${Math.min(progress.confirmations + 1, progress.expectedConfirmations)} of ${progress.expectedConfirmations}`;
    }
    return [
      {
        id: `${channel.uuid}:${utxo.txid}:${utxo.vout}`,
        direction: 'inbound',
        moveToken: MoveToken.BTC,
        amount: utxo.satoshis,
        fromLabel: 'Bitcoin Network',
        toLabel: getBitcoinChannelLabel(channel.vaultId),
        startedAt: utxo.firstSeenAt.getTime(),
        updatedAt: utxo.updatedAt.getTime(),
        progress: {
          progressPct: progress.progressPct,
          stepLabel: 'Funding Bitcoin channel',
          detail,
          error: utxo.statusError ?? wallets.bitcoinWallet.getChannelError(channel),
        },
      },
    ];
  });

  const activeBitcoinReleases = wallets.bitcoinWallet.getPendingChannelReleases().flatMap(channel => {
    const release = bitcoinLocks.releases.getActiveForLock(channel);
    return release ? [{ channel, release }] : [];
  });
  const failedBitcoinReleases = bitcoinLocks.releases.getUnacknowledgedFailedLockReleases().flatMap(release => {
    const channel = bitcoinLocks.getLockById(release.lockId);
    return channel ? [{ channel, release }] : [];
  });
  const bitcoinChannelReleases = [...activeBitcoinReleases, ...failedBitcoinReleases].map<PendingTransfer>(
    ({ channel, release }) => {
      const releaseDestination = release.toScriptPubkey;
      const releaseState = bitcoinLocks.getLockUnlockReleaseState(channel);
      const bitcoinProgress = bitcoinLocks.getReleaseProcessingDetails(release);
      const releaseProgress = getBitcoinReleaseProgress({
        release,
        releaseState,
        argonProgress: bitcoinLockRelease.getPendingReleaseTxInfo(channel.lockId!)?.getStatus(),
        vaultProgressPct: bitcoinLocks.getRequestReleaseByVaultProgress(channel, miningFrames),
        bitcoinProgress,
        cosignerLabel: getBitcoinCosignerLabel(channel.vaultId),
      });
      let destinationLabel = 'Bitcoin Network';
      try {
        destinationLabel = abbreviateAddress(bitcoinLocks.formatAddressBytes(releaseDestination), 8);
      } catch {
        destinationLabel = abbreviateAddress(releaseDestination, 8);
      }
      return {
        id: release.id,
        direction: 'outbound',
        moveToken: MoveToken.BTC,
        amount: release.destinationSatoshis + release.bitcoinNetworkFee,
        fromLabel: getBitcoinChannelLabel(channel.vaultId),
        toLabel: destinationLabel,
        startedAt: (release.bitcoinFirstSeenAt ?? release.createdAt).getTime(),
        updatedAt: (release.bitcoinLastConfirmationCheckAt ?? release.updatedAt).getTime(),
        progress: {
          progressPct: releaseProgress.progressPct,
          stepLabel: 'Sending Bitcoin',
          detail: releaseProgress.detail,
          error: release.statusError ?? bitcoinProgress.releaseError ?? '',
        },
      };
    },
  );

  return [...inboundTransfers, ...outboundTransfers, ...bitcoinChannelFundings, ...bitcoinChannelReleases].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
});
const failedTransferCount = Vue.computed(
  () => pendingTransfers.value.filter(transfer => !!transfer.progress.error).length,
);
const activeTransferCount = Vue.computed(() => pendingTransfers.value.length - failedTransferCount.value);

function getEthereumWalletLabel(address: string) {
  const wallet = wallets.ethereumWallets.findByAddress(address);
  if (wallet) return getEthereumWalletDisplayName(wallet.name);
  return address ? abbreviateAddress(address, 8) : 'Ethereum Wallet';
}

function getBitcoinChannelLabel(vaultId: number): string {
  return `${getBitcoinCosignerLabel(vaultId)} Channel`;
}

function getBitcoinCosignerLabel(vaultId: number): string {
  if (vaultId === (myVault.createdVault?.vaultId ?? myVault.vaultId)) return 'Your Vault';

  return (
    vaults.operatorNamesByVaultId[vaultId] ??
    (config.upstreamOperator?.vaultId === vaultId ? config.upstreamOperator.name : undefined) ??
    `Vault ${vaultId}`
  );
}

function formatAmount(value: bigint, moveToken: MoveToken) {
  if (moveToken === MoveToken.BTC) return satToBtcNm(value).format('0,0.[00000000]');
  if (moveToken === MoveToken.ARGNOT) return micronotToArgonotNm(value).format('0,0.[000000]');
  return microgonToArgonNm(value).format('0,0.[000000]');
}

function formatStartedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

Vue.onMounted(async () => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
  await loadPendingTransfers();
});

async function loadPendingTransfers(): Promise<void> {
  isLoadingTransfers.value = true;
  loadError.value = '';
  const results = await Promise.allSettled([
    inboundTracker.load(),
    outboundTracker.load(),
    wallets.bitcoinWallet.loadChannels(),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
  loadError.value = errors.join(' ');
  isLoadingTransfers.value = false;
}

Vue.onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
