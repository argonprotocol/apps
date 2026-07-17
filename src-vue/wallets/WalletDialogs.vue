<template>
  <WalletDialog
    v-if="openWallet"
    :rightWallet="openWallet.rightWallet"
    :leftWallet="openWallet.leftWallet"
    :availableWallets="availableWallets"
    :canAddDefaultEthereum="canAddDefaultEthereum"
    :showGuidance="openWallet.showGuidance"
    :guidanceContext="openWallet.guidanceContext"
    :zIndex="openWallet.zIndex"
    @focus="focusWallet"
    @selectLeftWallet="selectWallet('left', $event)"
    @selectRightWallet="selectWallet('right', $event)"
    @addDefaultEthereum="addDefaultEthereum"
    @addExternalEthereum="addExternalEthereum"
    @flip="flipWallets"
    @closeLeft="closeWallet('left')"
    @closeRight="closeWallet('right')"
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
  closeWalletOverlaySide,
  flipWalletOverlay,
  getAvailableWalletSelections,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  isEthereumWalletSelection,
  type IWalletOverlayState,
  type IWalletSelection,
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
  { type: 'open'; request: IWalletOverlayRequest } | { type: 'select'; side: 'left' | 'right' }
>();

const availableWallets = Vue.computed(() => {
  if (!openWallet.value) return [];

  const loadedWallets: IWalletSelection[] = [];
  if (openWallet.value.leftWallet) {
    loadedWallets.push(openWallet.value.leftWallet);
  }
  if (openWallet.value.rightWallet) {
    loadedWallets.push(openWallet.value.rightWallet);
  }

  return getAvailableWalletSelections(walletStore.walletRecords, loadedWallets, config.hasExtensionOperations);
});

const canAddDefaultEthereum = Vue.computed(
  () => !walletStore.walletRecords.some(record => record.role === 'defaultEthereum'),
);

function focusWallet() {
  if (!openWallet.value) return;
  openWallet.value.zIndex = reserveOverlayZIndex(openWallet.value.zIndex);
}

async function selectWallet(side: 'left' | 'right', wallet: IWalletSelection) {
  if (!openWallet.value) return;

  if (isEthereumWalletSelection(wallet)) {
    await walletStore.selectEthereumWalletRecord(wallet.walletRecord.id);
  }

  if (side === 'left') {
    openWallet.value.leftWallet = wallet;
  } else {
    openWallet.value.rightWallet = wallet;
  }

  await syncActiveEthereumWallet();
}

async function addDefaultEthereum(side: 'left' | 'right') {
  const walletRecord = await walletStore.createDefaultEthereumWallet();
  await selectWallet(side, { walletType: WalletType.ethereum, walletRecord });
}

function addExternalEthereum(side: 'left' | 'right') {
  pendingEthereumWalletAction.value = { type: 'select', side };
  basicEmitter.emit('openEthereumWalletImportOverlay', 'external');
}

function flipWallets() {
  if (!openWallet.value?.leftWallet || !openWallet.value.rightWallet) return;

  const nextState = flipWalletOverlay(openWallet.value);
  openWallet.value.leftWallet = nextState.leftWallet;
  openWallet.value.rightWallet = nextState.rightWallet;
  void syncActiveEthereumWallet();
}

function closeWallet(side: 'left' | 'right') {
  if (!openWallet.value) return;

  const nextState = closeWalletOverlaySide(openWallet.value, side);
  if (!nextState.leftWallet && !nextState.rightWallet) {
    closeOverlay();
    return;
  }

  openWallet.value.leftWallet = nextState.leftWallet;
  openWallet.value.rightWallet = nextState.rightWallet;
  void syncActiveEthereumWallet();
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

  if (isEthereumWalletSelection(wallet)) {
    await walletStore.selectEthereumWalletRecord(wallet.walletRecord.id);
  }

  if (openWallet.value) {
    const walletKey = getWalletSelectionKey(wallet);
    const isAlreadyOpen = [openWallet.value.leftWallet, openWallet.value.rightWallet].some(
      currentWallet => currentWallet && getWalletSelectionKey(currentWallet) === walletKey,
    );
    if (!isAlreadyOpen) {
      if (!openWallet.value.rightWallet) {
        openWallet.value.rightWallet = wallet;
      } else if (!openWallet.value.leftWallet) {
        openWallet.value.leftWallet = wallet;
      }
    }
    openWallet.value.showGuidance = request.showGuidance ?? false;
    openWallet.value.guidanceContext = request.guidanceContext;
    focusWallet();
    await syncActiveEthereumWallet();
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
    return;
  }

  await selectWallet(action.side, { walletType: WalletType.ethereum, walletRecord });
}

function getRequestedWallet(
  request: IWalletOverlayRequest,
  ethereumWalletRecord?: IWalletRecord,
): IWalletSelection | undefined {
  if (request.walletType === WalletType.defaultArgon) {
    return { walletType: WalletType.defaultArgon };
  }
  if (request.walletType === WalletType.miningBot) {
    return { walletType: WalletType.miningBot };
  }

  const activeWalletRecord = walletStore.walletRecords.find(
    record => record.id === walletStore.activeEthereumWalletRecordId,
  );
  const walletRecord =
    ethereumWalletRecord ??
    activeWalletRecord ??
    walletStore.walletRecords.find(record => record.walletType === 'ethereum');
  return walletRecord ? { walletType: WalletType.ethereum, walletRecord } : undefined;
}

async function syncActiveEthereumWallet() {
  if (!openWallet.value) return;

  const ethereumWallets = [openWallet.value.leftWallet, openWallet.value.rightWallet].filter(
    (wallet): wallet is Extract<IWalletSelection, { walletType: WalletType.ethereum }> =>
      !!wallet && isEthereumWalletSelection(wallet),
  );
  if (ethereumWallets.length !== 1) return;

  const recordId = ethereumWallets[0].walletRecord.id;
  if (walletStore.activeEthereumWalletRecordId !== recordId) {
    await walletStore.selectEthereumWalletRecord(recordId);
  }
}

function closeOverlay() {
  if (openWallet.value) {
    releaseOverlayZIndex(openWallet.value.zIndex);
  }
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
