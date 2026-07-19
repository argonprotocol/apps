<template>
  <WalletDialog
    v-if="openWallet"
    :primaryWallet="openWallet.primaryWallet"
    :primaryAddWalletStep="openWallet.primaryAddWalletStep"
    :transferIn="openWallet.transferIn"
    :transferOut="openWallet.transferOut"
    :walletSelections="walletSelections"
    :availableWallets="availableWallets"
    :canAddDefaultEthereum="canAddDefaultEthereum"
    :showGuidance="openWallet.showGuidance"
    :guidanceContext="openWallet.guidanceContext"
    :zIndex="openWallet.zIndex"
    @focus="focusWallet"
    @selectPrimaryWallet="setPrimaryWallet"
    @toggleTransferDirection="toggleTransferDirection"
    @selectTransferWallet="setTransferWallet"
    @returnToTransferWalletChooser="returnToTransferWalletChooser"
    @addNewWallet="addNewWallet"
    @addDefaultEthereum="addDefaultEthereum"
    @addExternalEthereum="addExternalEthereum"
    @completeAddWallet="completeAddWallet"
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
import { getConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import WalletDialog from './WalletDialog.vue';
import {
  getAvailableWalletSelections,
  getInitialAddWalletOverlayState,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  isEthereumWalletSelection,
  returnToTransferWalletChooser as getChooserState,
  selectPrimaryWallet,
  selectTransferWallet,
  showAddWalletOnTransferSide,
  toggleWalletTransferDirection,
  type IWalletOverlayState,
  type IWalletSelection,
  type IWalletTransferDirection,
} from './walletOverlayState.ts';

type IOpenWallet = IWalletOverlayState & {
  showGuidance: boolean;
  guidanceContext?: IWalletGuidanceContext;
  zIndex: number;
};

const basics = useBasics();
const config = getConfig();
const walletStore = useWallets();
const openWallet = Vue.ref<IOpenWallet>();

const walletSelections = Vue.computed(() =>
  getAvailableWalletSelections(walletStore.walletRecords, [], config.hasExtensionOperations),
);
const availableWallets = Vue.computed(() => {
  if (!openWallet.value?.primaryWallet) return [];
  return getAvailableWalletSelections(
    walletStore.walletRecords,
    [openWallet.value.primaryWallet],
    config.hasExtensionOperations,
  );
});
const canAddDefaultEthereum = Vue.computed(
  () => !walletStore.walletRecords.some(record => record.role === 'defaultEthereum'),
);

function focusWallet() {
  if (!openWallet.value) return;
  openWallet.value.zIndex = reserveOverlayZIndex(openWallet.value.zIndex);
}

async function setPrimaryWallet(wallet: IWalletSelection) {
  if (!openWallet.value) return;
  await activateEthereumWallet(wallet);
  Object.assign(openWallet.value, selectPrimaryWallet(openWallet.value, wallet));
  openWallet.value.primaryAddWalletStep = undefined;
  openWallet.value.transferIn = undefined;
  openWallet.value.transferOut = undefined;
}

function toggleTransferDirection(direction: IWalletTransferDirection) {
  if (!openWallet.value) return;
  const nextState = toggleWalletTransferDirection(openWallet.value, direction);
  openWallet.value.transferIn = nextState.transferIn;
  openWallet.value.transferOut = nextState.transferOut;
}

async function setTransferWallet(direction: IWalletTransferDirection, wallet: IWalletSelection) {
  if (!openWallet.value) return;
  await activateEthereumWallet(wallet);
  const nextState = selectTransferWallet(openWallet.value, direction, wallet);
  openWallet.value.transferIn = nextState.transferIn;
  openWallet.value.transferOut = nextState.transferOut;
}

function returnToTransferWalletChooser(direction: IWalletTransferDirection) {
  if (!openWallet.value) return;
  const nextState = getChooserState(openWallet.value, direction);
  openWallet.value.transferIn = nextState.transferIn;
  openWallet.value.transferOut = nextState.transferOut;
}

async function addDefaultEthereum(direction: IWalletTransferDirection) {
  const walletRecord = await walletStore.createDefaultEthereumWallet();
  await setTransferWallet(direction, { walletType: WalletType.ethereum, walletRecord });
}

function addExternalEthereum(direction: IWalletTransferDirection) {
  showSidecarAddWallet(direction, 'external');
}

function addNewWallet(direction: IWalletTransferDirection) {
  showSidecarAddWallet(direction, canAddDefaultEthereum.value ? 'choice' : 'external');
}

function showSidecarAddWallet(direction: IWalletTransferDirection, initialStep: 'choice' | 'external') {
  if (!openWallet.value) return;
  const nextState = showAddWalletOnTransferSide(openWallet.value, direction, initialStep);
  openWallet.value.transferIn = nextState.transferIn;
  openWallet.value.transferOut = nextState.transferOut;
}

const openWalletOverlay = async (request: IWalletOverlayRequest, ethereumWalletRecord?: IWalletRecord) => {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to refresh wallet balances before opening wallet overlay', error);
  }

  const wallet = getRequestedWallet(request, ethereumWalletRecord);
  if (!wallet) {
    await openAddWalletPanel('choice', request.showGuidance ?? false, request.guidanceContext);
    return;
  }

  await activateEthereumWallet(wallet);
  if (openWallet.value) {
    if (
      !openWallet.value.primaryWallet ||
      getWalletSelectionKey(openWallet.value.primaryWallet) !== getWalletSelectionKey(wallet)
    ) {
      await setPrimaryWallet(wallet);
    }
    openWallet.value.showGuidance = request.showGuidance ?? false;
    openWallet.value.guidanceContext = request.guidanceContext;
    focusWallet();
    return;
  }

  openWallet.value = {
    ...getInitialWalletOverlayState(wallet),
    showGuidance: request.showGuidance ?? false,
    guidanceContext: request.guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
};

async function completeAddWallet(target: 'primary' | IWalletTransferDirection, walletRecord: IWalletRecord) {
  const wallet = { walletType: WalletType.ethereum, walletRecord } as const;
  if (target === 'primary') {
    await setPrimaryWallet(wallet);
    return;
  }
  await setTransferWallet(target, wallet);
}

async function openAddWalletPanel(
  initialStep: 'choice' | 'external',
  showGuidance = false,
  guidanceContext?: IWalletGuidanceContext,
) {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to load wallets before opening Add Wallet', error);
  }
  if (openWallet.value) {
    openWallet.value.primaryWallet = undefined;
    openWallet.value.primaryAddWalletStep = initialStep;
    openWallet.value.transferIn = undefined;
    openWallet.value.transferOut = undefined;
    openWallet.value.showGuidance = showGuidance;
    openWallet.value.guidanceContext = guidanceContext;
    focusWallet();
    return;
  }
  openWallet.value = {
    ...getInitialAddWalletOverlayState(initialStep),
    showGuidance,
    guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
}

function getRequestedWallet(
  request: IWalletOverlayRequest,
  ethereumWalletRecord?: IWalletRecord,
): IWalletSelection | undefined {
  if (request.walletType === WalletType.defaultArgon) return { walletType: WalletType.defaultArgon };
  if (request.walletType === WalletType.miningBot) return { walletType: WalletType.miningBot };

  const walletRecord =
    ethereumWalletRecord ??
    walletStore.walletRecords.find(record => record.id === request.ethereumWalletRecordId) ??
    walletStore.walletRecords.find(record => record.id === walletStore.activeEthereumWalletRecordId) ??
    walletStore.walletRecords.find(record => record.walletType === 'ethereum');
  return walletRecord ? { walletType: WalletType.ethereum, walletRecord } : undefined;
}

async function activateEthereumWallet(wallet: IWalletSelection) {
  if (isEthereumWalletSelection(wallet) && walletStore.activeEthereumWalletRecordId !== wallet.walletRecord.id) {
    await walletStore.selectEthereumWalletRecord(wallet.walletRecord.id);
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
basicEmitter.on('openEthereumWalletImportOverlay', openAddWalletPanel);
Vue.onUnmounted(() => {
  basicEmitter.off('openWalletOverlay', openWalletOverlay);
  basicEmitter.off('openEthereumWalletImportOverlay', openAddWalletPanel);
  closeOverlay();
});
</script>
