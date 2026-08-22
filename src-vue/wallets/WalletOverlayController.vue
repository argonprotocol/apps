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
    @goto="showView"
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
  showWalletView,
  type IWalletConnectorTarget,
  type IWalletOverlayState,
  type IWalletSelection,
  type IWalletView,
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
    console.error(`Ethereum wallet record not found: ${request.ethereumWalletRecordId}`);
    return;
  }

  if (activeConnector?.network === 'ethereum') await refreshEthereumWalletIfNeeded(activeConnector.walletRecordId);

  if (openWallet.value) {
    Object.assign(openWallet.value, showWalletView(openWallet.value, request.view ?? 'main', activeConnector));
    openWallet.value.showGuidance = request.showGuidance ?? false;
    openWallet.value.guidanceContext = request.guidanceContext;
    focusWallet();
    return;
  }

  const initialState = getInitialWalletOverlayState(activeConnector);
  openWallet.value = {
    ...showWalletView(initialState, request.view ?? 'main', activeConnector),
    showGuidance: request.showGuidance ?? false,
    guidanceContext: request.guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
};

function showView(view: IWalletView) {
  if (!openWallet.value) return;
  Object.assign(openWallet.value, showWalletView(openWallet.value, view, openWallet.value.activeConnector));
}

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
  await refreshEthereumWalletIfNeeded(walletRecord.id);
  Object.assign(
    openWallet.value,
    showWalletView(openWallet.value, 'main', { network: 'ethereum', walletRecordId: walletRecord.id }),
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
  if (request.connectorType === WalletType.argon) return;
  if (request.connectorType === 'bitcoin') return { network: 'bitcoin' };
  const walletRecord = walletStore.walletRecords.find(
    record => record.walletType === 'ethereum' && record.id === request.ethereumWalletRecordId,
  );
  return walletRecord ? { network: 'ethereum', walletRecordId: walletRecord.id } : undefined;
}

async function refreshEthereumWalletIfNeeded(walletRecordId: number) {
  const balanceUpdatedAt = walletStore.getEthereumWalletRecord(walletRecordId).balanceUpdatedAt;
  if (!balanceUpdatedAt) await walletStore.refreshEthereumWalletRecord(walletRecordId);
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
