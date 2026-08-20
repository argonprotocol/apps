<template>
  <WalletOverlay
    v-if="openWallet"
    :centerView="openWallet.centerView"
    :activeConnector="openWallet.activeConnector"
    :walletSelections="walletSelections"
    :showGuidance="openWallet.showGuidance"
    :guidanceContext="openWallet.guidanceContext"
    :zIndex="openWallet.zIndex"
    @focus="focusWallet"
    @updateActiveConnector="updateActiveConnector"
    @addConnector="openAddConnectorFromOverlay"
    @closeAddConnector="closeAddConnector"
    @completeAddConnector="completeAddConnector"
    @close="closeOverlay"
  />
</template>

<script lang="ts">
import { ref } from 'vue';

export const openWalletOverlayCount = ref(0);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter, { type IWalletGuidanceContext, type IWalletOverlayRequest } from '../emitters/basicEmitter.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import { releaseOverlayZIndex, reserveOverlayZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import { useBasics } from '../stores/basics.ts';
import { useWallets } from '../stores/wallets.ts';
import WalletOverlay from './WalletOverlay.vue';
import {
  closeAddWalletView,
  getInitialAddWalletOverlayState,
  getInitialWalletOverlayState,
  showAddWalletInOverlay,
  showMainWallet,
  shouldLoadEthereumWalletSelection,
  type IWalletConnectorTarget,
  type IWalletOverlayState,
  type IWalletSelection,
} from './walletOverlayState.ts';

type IOpenWallet = IWalletOverlayState & {
  showGuidance: boolean;
  guidanceContext?: IWalletGuidanceContext;
  zIndex: number;
};

const basics = useBasics();
const walletStore = useWallets();
const openWallet = Vue.ref<IOpenWallet>();

const walletSelections = Vue.computed<IWalletSelection[]>(() => {
  return walletStore.walletRecords
    .filter(walletRecord => walletRecord.walletType === 'ethereum')
    .map(walletRecord => ({ walletType: WalletType.ethereum, walletRecord }));
});

function focusWallet() {
  if (!openWallet.value) return;
  openWallet.value.zIndex = reserveOverlayZIndex(openWallet.value.zIndex);
}

function updateActiveConnector(target: IWalletConnectorTarget | undefined) {
  if (!openWallet.value) return;
  openWallet.value.activeConnector = target;
}

const openWalletOverlay = async (request: IWalletOverlayRequest) => {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to refresh wallet balances before opening wallet overlay', error);
  }

  const activeConnector = getRequestedConnector(request);
  if (request.connectorType === WalletType.ethereum && !activeConnector) {
    await openAddWalletPanel('external', request.showGuidance ?? false, request.guidanceContext);
    return;
  }

  if (activeConnector?.network === 'ethereum') await activateEthereumWallet(activeConnector.walletRecordId);

  if (openWallet.value) {
    Object.assign(openWallet.value, showMainWallet(openWallet.value, activeConnector));
    openWallet.value.showGuidance = request.showGuidance ?? false;
    openWallet.value.guidanceContext = request.guidanceContext;
    focusWallet();
    return;
  }

  openWallet.value = {
    ...getInitialWalletOverlayState(activeConnector),
    showGuidance: request.showGuidance ?? false,
    guidanceContext: request.guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
};

function openAddConnectorFromOverlay() {
  if (!openWallet.value) return;
  Object.assign(openWallet.value, showAddWalletInOverlay(openWallet.value, 'external'));
}

function closeAddConnector() {
  if (!openWallet.value) return;
  const nextState = closeAddWalletView(openWallet.value);
  if (!nextState) {
    closeOverlay();
    return;
  }
  Object.assign(openWallet.value, nextState);
}

async function completeAddConnector(walletRecord: IWalletRecord) {
  if (!openWallet.value) return;
  await activateEthereumWallet(walletRecord.id);
  Object.assign(
    openWallet.value,
    showMainWallet(openWallet.value, { network: 'ethereum', walletRecordId: walletRecord.id }),
  );
}

async function openAddWalletPanel(
  initialStep: 'choice' | 'external',
  showGuidance = false,
  guidanceContext?: IWalletGuidanceContext,
) {
  if (!walletStore.isLoaded) {
    try {
      await walletStore.load();
    } catch (error) {
      console.error('Failed to load wallets before opening Add Wallet', error);
    }
  }
  if (openWallet.value) {
    Object.assign(openWallet.value, showAddWalletInOverlay(openWallet.value, initialStep));
    openWallet.value.showGuidance = showGuidance;
    openWallet.value.guidanceContext = guidanceContext;
    focusWallet();
    return;
  }
  openWallet.value = {
    ...getInitialAddWalletOverlayState(initialStep, 'closeOverlay'),
    showGuidance,
    guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
}

function getRequestedConnector(request: IWalletOverlayRequest): IWalletConnectorTarget | undefined {
  if (request.connectorType === WalletType.defaultArgon) return;
  if (request.connectorType === 'bitcoin') return { network: 'bitcoin' };
  const walletRecord = request.ethereumWalletRecordId
    ? walletStore.walletRecords.find(record => record.id === request.ethereumWalletRecordId)
    : (walletStore.walletRecords.find(record => record.id === walletStore.activeEthereumWalletRecordId) ??
      walletStore.walletRecords.find(record => record.walletType === 'ethereum'));
  return walletRecord ? { network: 'ethereum', walletRecordId: walletRecord.id } : undefined;
}

async function activateEthereumWallet(walletRecordId: number) {
  const walletRecord = walletStore.walletRecords.find(record => record.id === walletRecordId);
  if (!walletRecord) return;
  const wallet = { walletType: WalletType.ethereum, walletRecord } as const;
  const balanceUpdatedAt = walletStore.getEthereumWalletRecord(walletRecordId).balanceUpdatedAt;
  if (shouldLoadEthereumWalletSelection(wallet, walletStore.activeEthereumWalletRecordId, balanceUpdatedAt)) {
    await walletStore.selectEthereumWalletRecord(walletRecordId);
  }
}

function ethereumWalletDisconnected({ walletRecordId }: { walletRecordId: number }) {
  if (
    openWallet.value?.activeConnector?.network === 'ethereum' &&
    openWallet.value.activeConnector.walletRecordId === walletRecordId
  ) {
    openWallet.value.activeConnector = undefined;
  }
}

function closeOverlay() {
  if (openWallet.value) releaseOverlayZIndex(openWallet.value.zIndex);
  openWallet.value = undefined;
  syncOverlayState();
}

function syncOverlayState() {
  const count = openWallet.value ? 1 : 0;
  basics.overlayIsOpen = count > 0;
  openWalletOverlayCount.value = count;
}

basicEmitter.on('openWalletOverlay', openWalletOverlay);
basicEmitter.on('openWalletOverlayAddConnector', openAddWalletPanel);
basicEmitter.on('ethereumWalletDisconnected', ethereumWalletDisconnected);
Vue.onUnmounted(() => {
  basicEmitter.off('openWalletOverlay', openWalletOverlay);
  basicEmitter.off('openWalletOverlayAddConnector', openAddWalletPanel);
  basicEmitter.off('ethereumWalletDisconnected', ethereumWalletDisconnected);
  closeOverlay();
});
</script>
