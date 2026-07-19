<template>
  <WalletDialog
    v-if="openWallet"
    :primaryWallet="openWallet.primaryWallet"
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
    @close="closeOverlay"
  />
  <EthereumWalletImportOverlay
    @complete="completeEthereumWalletSetup"
    @cancel="pendingEthereumWalletAction = undefined"
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
import EthereumWalletImportOverlay from './EthereumWalletImportOverlay.vue';
import WalletDialog from './WalletDialog.vue';
import {
  getAvailableWalletSelections,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  isEthereumWalletSelection,
  returnToTransferWalletChooser as getChooserState,
  selectPrimaryWallet,
  selectTransferWallet,
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
const pendingEthereumWalletAction = Vue.ref<
  { type: 'open'; request: IWalletOverlayRequest } | { type: 'transfer'; direction: IWalletTransferDirection }
>();

const walletSelections = Vue.computed(() =>
  getAvailableWalletSelections(walletStore.walletRecords, [], config.hasExtensionOperations),
);
const availableWallets = Vue.computed(() => {
  if (!openWallet.value) return [];
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
  pendingEthereumWalletAction.value = { type: 'transfer', direction };
  basicEmitter.emit('openEthereumWalletImportOverlay', 'external');
}

function addNewWallet(direction: IWalletTransferDirection) {
  if (canAddDefaultEthereum.value) {
    void addDefaultEthereum(direction);
    return;
  }
  addExternalEthereum(direction);
}

const openWalletOverlay = async (request: IWalletOverlayRequest, ethereumWalletRecord?: IWalletRecord) => {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to refresh wallet balances before opening wallet overlay', error);
  }

  const wallet = getRequestedWallet(request, ethereumWalletRecord);
  if (!wallet) {
    pendingEthereumWalletAction.value = { type: 'open', request };
    basicEmitter.emit('openEthereumWalletImportOverlay', 'choice');
    return;
  }

  await activateEthereumWallet(wallet);
  if (openWallet.value) {
    if (getWalletSelectionKey(openWallet.value.primaryWallet) !== getWalletSelectionKey(wallet)) {
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

async function completeEthereumWalletSetup(walletRecord: IWalletRecord) {
  const action = pendingEthereumWalletAction.value;
  pendingEthereumWalletAction.value = undefined;
  if (!action) return;
  if (action.type === 'open') {
    await openWalletOverlay(action.request, walletRecord);
  } else {
    await setTransferWallet(action.direction, { walletType: WalletType.ethereum, walletRecord });
  }
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
Vue.onUnmounted(() => {
  basicEmitter.off('openWalletOverlay', openWalletOverlay);
  closeOverlay();
});
</script>
