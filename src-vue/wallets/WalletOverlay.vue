<template>
  <DialogRoot v-if="openWallet" :open="true" :modal="true" @update:open="handleDialogOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay
          class="bg-black/40"
          :style="{ zIndex: getOverlayBackdropZIndex(openWallet.zIndex) }"
          :blurContent="true"
          @pointerdown.capture="dialogDismissRequested = false"
          @close="closeFromBackdrop"
        />
      </DialogOverlay>
      <DialogContent
        :aria-describedby="undefined"
        :style="{ zIndex: openWallet.zIndex }"
        @escapeKeyDown.prevent="closeOverlay"
        class="pointer-events-none! fixed inset-0"
      >
        <div
          :ref="setWalletRef"
          data-testid="WalletOverlay"
          :style="{
            top: `calc(50% + ${draggable.modalPosition.y}px)`,
            left: `calc(50% + ${draggable.modalPosition.x}px)`,
            transform: 'translate(-50%, -50%)',
          }"
          class="pointer-events-auto absolute z-10 flex min-h-140 items-stretch focus:outline-none"
          @mousedown="focusWallet"
        >
          <div>
            <div
              :class="
                twMerge(
                  openWallet.centerView.type === 'addEthereum' ? '' : 'bg-neutral-600',
                  activeConnectorId ? 'bg-neutral-600/50' : '',
                )
              "
              class="relative z-20 flex h-full w-120 shrink-0 p-2"
            >
              <svg
                v-if="openWallet.centerView.type !== 'addEthereum'"
                class="pointer-events-none absolute inset-0 h-full w-full text-neutral-400 shadow-sm/40"
              >
                <rect
                  x="1.25"
                  y="1.25"
                  width="calc(100% - 2.5px)"
                  height="calc(100% - 2.5px)"
                  rx="8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="4"
                  stroke-dasharray="8 4"
                />
              </svg>
              <div
                :class="activeConnectorId ? 'bg-neutral-300/80' : 'bg-white'"
                class="absolute top-2 right-2 bottom-2 left-2 rounded-lg border border-black/60 shadow-sm/30"
              />
              <section
                :class="activeConnectorId ? 'pointer-events-none opacity-70' : ''"
                class="relative w-full overflow-visible"
              >
                <WalletViewMain
                  v-if="openWallet.centerView.type === 'main'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="openWallet.showGuidance"
                  :guidanceContext="openWallet.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="showView"
                  @close="closeWalletViewOrOverlay"
                />
                <WalletViewSend
                  v-else-if="openWallet.centerView.type === 'send'"
                  :isDragging="draggable.isDragging"
                  :activeConnector="openWallet.activeConnector"
                  :showGuidance="openWallet.showGuidance"
                  :guidanceContext="openWallet.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @selectDestinationConnector="selectSendDestinationConnector"
                  @goto="showView"
                  @close="closeWalletViewOrOverlay"
                />
                <WalletViewReceive
                  v-else-if="openWallet.centerView.type === 'receive'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="openWallet.showGuidance"
                  :guidanceContext="openWallet.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="showView"
                  @close="closeWalletViewOrOverlay"
                />
                <WalletViewPrivateKey
                  v-else-if="openWallet.centerView.type === 'privateKey'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="openWallet.showGuidance"
                  :guidanceContext="openWallet.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="showView"
                  @close="closeWalletViewOrOverlay"
                />
                <WalletViewAddConnector
                  v-else
                  :initialStep="openWallet.centerView.initialStep"
                  :isDragging="draggable.isDragging"
                  @dragStart="draggable.onMouseDown($event)"
                  @close="closeWalletViewOrOverlay"
                  @complete="completeAddConnector"
                />
              </section>
            </div>
            <section
              v-if="openWallet.centerView.type !== 'addEthereum'"
              class="absolute top-0 right-full flex h-full flex-col justify-between py-5"
            >
              <article
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== WalletType.bitcoin
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <Connector
                  :wallet="walletStore.bitcoinWallet"
                  direction="left"
                  :open="openWallet.activeConnector === walletStore.bitcoinWallet"
                  @update:open="updateBitcoinConnector($event)"
                />
                <svg aria-hidden="true" class="relative mx-1 h-1 w-40 text-neutral-400/80 shadow-sm/40">
                  <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
                </svg>
              </article>
              <article
                v-for="wallet of leftExternalConnectors"
                :key="wallet.id"
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== wallet.id
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <Connector
                  direction="left"
                  :wallet="wallet"
                  :open="isEthereumConnectorOpen(wallet)"
                  :transferDirections="getTransferDirections(wallet.id!)"
                  @update:open="updateEthereumConnector(wallet, $event)"
                />
                <ConnectorTransferActivity side="left" :transferDirections="getTransferDirections(wallet.id!)" />
              </article>
              <article
                v-for="slot in 2 - leftExternalConnectors.length"
                :key="`left-external-connector-${slot}`"
                :class="connectorSelectionIsActive ? 'pointer-events-none opacity-20' : ''"
                class="flex flex-row items-center"
              >
                <Connector direction="left" :open="false" @addConnector="openAddConnectorFromOverlay" />
                <svg aria-hidden="true" class="relative mx-1 h-1 w-40 text-neutral-400/80 shadow-sm/40">
                  <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
                </svg>
              </article>
            </section>

            <section
              v-if="openWallet.centerView.type !== 'addEthereum'"
              class="absolute top-0 left-full flex h-full flex-col justify-between py-5"
            >
              <article
                v-for="wallet of rightExternalConnectors"
                :key="wallet.id"
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== wallet.id
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <ConnectorTransferActivity side="right" :transferDirections="getTransferDirections(wallet.id!)" />
                <Connector
                  direction="right"
                  :wallet="wallet"
                  :open="isEthereumConnectorOpen(wallet)"
                  :transferDirections="getTransferDirections(wallet.id!)"
                  @update:open="updateEthereumConnector(wallet, $event)"
                />
              </article>
              <article
                v-for="slot in 3 - rightExternalConnectors.length"
                :key="`right-external-connector-${slot}`"
                :class="connectorSelectionIsActive ? 'pointer-events-none opacity-20' : ''"
                class="flex flex-row items-center"
              >
                <svg aria-hidden="true" class="relative mx-1 h-1 w-40 text-neutral-400/80 shadow-sm/40">
                  <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
                </svg>
                <Connector direction="right" :open="false" @addConnector="openAddConnectorFromOverlay" />
              </article>
            </section>
          </div>
        </div>
        <WalletBottomBar
          v-if="openWallet.centerView.type !== 'addEthereum'"
          :class="activeConnectorId ? 'opacity-30' : ''"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'reka-ui';
import BgOverlay from '../components/BgOverlay.vue';
import basicEmitter, { type IWalletGuidanceContext, type IWalletOverlayOptions } from '../emitters/basicEmitter.ts';
import type { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletType } from '../lib/Wallet.ts';
import Draggable from '../overlays/helpers/Draggable.ts';
import {
  getOverlayBackdropZIndex,
  provideOverlayContentZIndex,
  releaseOverlayZIndex,
  reserveOverlayZIndex,
} from '../overlays/helpers/OverlayZIndex.ts';
import { useBasics } from '../stores/basics.ts';
import { getEthereumMoveTracker } from '../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../stores/moveToEthereum.ts';
import { useWallets } from '../stores/wallets.ts';
import WalletBottomBar from './components/WalletBottomBar.vue';
import Connector from './components/Connector.vue';
import ConnectorTransferActivity from './components/ConnectorTransferActivity.vue';
import { isCrosschainTransferActive, type ICrosschainTransferDirection } from './components/crosschainTransferView.ts';
import WalletViewAddConnector from './components/WalletViewAddConnector.vue';
import WalletViewMain from './components/WalletViewMain.vue';
import WalletViewPrivateKey from './components/WalletViewPrivateKey.vue';
import WalletViewReceive from './components/WalletViewReceive.vue';
import WalletViewSend from './components/WalletViewSend.vue';
import {
  closeWalletView,
  getInitialAddWalletOverlayState,
  getInitialWalletOverlayState,
  showAddWalletInOverlay,
  showWalletView,
  type IWalletConnector,
  type IWalletOverlayState,
  type IWalletView,
} from './walletOverlayState.ts';
import { twMerge } from 'tailwind-merge';

type IOpenWallet = IWalletOverlayState & {
  showGuidance: boolean;
  guidanceContext?: IWalletGuidanceContext;
  zIndex: number;
};

const basics = useBasics();
const walletStore = useWallets();
const openWallet = Vue.ref<IOpenWallet>();
const ethereumWallets = Vue.computed(() => walletStore.ethereumWallets.persistedWallets);

const sendDestinationConnectorId = Vue.ref<string | number>();
const activeConnectorId = Vue.computed<string | number | undefined>(() => {
  if (openWallet.value?.activeConnector?.type === WalletType.bitcoin) return WalletType.bitcoin;
  return openWallet.value?.activeConnector?.id;
});
const connectorSelectionIsActive = Vue.computed(
  () => activeConnectorId.value !== undefined || openWallet.value?.centerView.type === 'send',
);
const highlightedConnectorId = Vue.computed(() => {
  if (activeConnectorId.value !== undefined) return activeConnectorId.value;
  return openWallet.value?.centerView.type === 'send' ? sendDestinationConnectorId.value : undefined;
});
const draggable = Vue.reactive(new Draggable({ constrainToViewport: false }));
const inboundTracker = getEthereumMoveTracker();
const outboundTracker = getEthereumOutboundTransferTracker();
const leftExternalConnectors = Vue.computed(() => {
  return ethereumWallets.value.filter((_, index) => index % 2 === 1).slice(0, 2);
});
const rightExternalConnectors = Vue.computed(() => {
  return ethereumWallets.value.filter((_, index) => index % 2 === 0).slice(0, 3);
});
const activeTransferDirectionsByWalletRecordId = Vue.computed(() => {
  const walletRecordIdByAddress = new Map(
    ethereumWallets.value.map(wallet => [wallet.address.toLowerCase(), wallet.id!]),
  );
  const directionsByWalletRecordId = new Map<number, ICrosschainTransferDirection[]>();

  function addDirection(address: string | undefined, direction: ICrosschainTransferDirection) {
    if (!address) return;
    const walletRecordId = walletRecordIdByAddress.get(address.toLowerCase());
    if (walletRecordId === undefined) return;
    const directions = directionsByWalletRecordId.get(walletRecordId) ?? [];
    if (!directions.includes(direction)) directions.push(direction);
    directionsByWalletRecordId.set(walletRecordId, directions);
  }

  for (const transfer of Object.values(inboundTracker.data.transfersById)) {
    if (!isCrosschainTransferActive(transfer.transferState)) continue;
    addDirection(transfer.persistedRecord?.sourceAddress ?? transfer.sourceAddress, 'inbound');
  }

  for (const transfer of Object.values(outboundTracker.data.transfersById)) {
    if (!isCrosschainTransferActive(transfer.transferState)) continue;
    addDirection(transfer.persistedRecord?.destinationAddress ?? transfer.destinationAddress, 'outbound');
  }

  return directionsByWalletRecordId;
});
let dialogDismissRequested = false;

provideOverlayContentZIndex(Vue.computed(() => openWallet.value?.zIndex ?? 0));

function focusWallet() {
  if (!openWallet.value) return;
  openWallet.value.zIndex = reserveOverlayZIndex(openWallet.value.zIndex);
}

function updateActiveConnector(wallet: IWalletConnector | undefined) {
  if (!openWallet.value) return;
  openWallet.value.activeConnector = wallet;
}

const openWalletOverlay = async (options: IWalletOverlayOptions) => {
  try {
    await walletStore.load();
  } catch (error) {
    console.error('Failed to refresh wallet balances before opening wallet overlay', error);
  }

  if (!requestedWalletIsAvailable(options.wallet)) {
    console.error(`Requested ${options.wallet.type} wallet is no longer available.`);
    return;
  }
  const activeConnector = options.wallet.type === WalletType.argon ? undefined : options.wallet;

  if (activeConnector?.type === WalletType.ethereum) await refreshEthereumWalletIfNeeded(activeConnector);

  if (openWallet.value) {
    Object.assign(openWallet.value, showWalletView(openWallet.value, options.view ?? 'main', activeConnector));
    openWallet.value.showGuidance = options.showGuidance ?? false;
    openWallet.value.guidanceContext = options.guidanceContext;
    focusWallet();
    return;
  }

  resetOverlayPresentation();
  const initialState = getInitialWalletOverlayState(activeConnector);
  openWallet.value = {
    ...showWalletView(initialState, options.view ?? 'main', activeConnector),
    showGuidance: options.showGuidance ?? false,
    guidanceContext: options.guidanceContext,
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

function closeWalletViewOrOverlay() {
  if (!openWallet.value) return;
  const nextState = closeWalletView(openWallet.value);
  if (!nextState) {
    closeOverlay();
    return;
  }
  Object.assign(openWallet.value, nextState);
}

async function completeAddConnector(wallet: WalletForEthereum) {
  if (!openWallet.value) return;
  await refreshEthereumWalletIfNeeded(wallet);
  Object.assign(openWallet.value, showWalletView(openWallet.value, 'main', wallet));
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

  resetOverlayPresentation();
  openWallet.value = {
    ...getInitialAddWalletOverlayState(initialStep),
    showGuidance,
    guidanceContext,
    zIndex: reserveOverlayZIndex(),
  };
  syncOverlayState();
}

function requestedWalletIsAvailable(wallet: IWalletOverlayOptions['wallet']): boolean {
  if (wallet.type === WalletType.argon) return wallet === walletStore.argonWallets.defaultArgonWallet;
  if (wallet.type === WalletType.bitcoin) return wallet === walletStore.bitcoinWallet;
  return walletStore.ethereumWallets.persistedWallets.includes(wallet);
}

async function refreshEthereumWalletIfNeeded(wallet: WalletForEthereum) {
  if (!wallet.data.balanceUpdatedAt) await wallet.refresh();
}

function ethereumWalletDisconnected({ wallet }: { wallet: WalletForEthereum }) {
  if (openWallet.value?.activeConnector === wallet) {
    openWallet.value.activeConnector = undefined;
  }
}

function closeOverlay() {
  if (openWallet.value) releaseOverlayZIndex(openWallet.value.zIndex);
  openWallet.value = undefined;
  syncOverlayState();
}

function syncOverlayState() {
  basics.overlayIsOpen = openWallet.value !== undefined;
}

function isEthereumConnectorOpen(wallet: WalletForEthereum) {
  return openWallet.value?.activeConnector === wallet;
}

function getTransferDirections(walletRecordId: number) {
  return activeTransferDirectionsByWalletRecordId.value.get(walletRecordId) ?? [];
}

function selectSendDestinationConnector(connectorId: string | number | undefined) {
  sendDestinationConnectorId.value = connectorId;
}

function updateBitcoinConnector(isOpen: boolean) {
  updateActiveConnector(isOpen ? walletStore.bitcoinWallet : undefined);
}

function updateEthereumConnector(wallet: WalletForEthereum, isOpen: boolean) {
  updateActiveConnector(isOpen ? wallet : undefined);
}

function setWalletRef(element: Element | Vue.ComponentPublicInstance | null) {
  draggable.setModalRef(element);
}

function handleDialogOpen(isOpen: boolean) {
  if (!isOpen) dialogDismissRequested = true;
}

function closeFromBackdrop() {
  if (!dialogDismissRequested) return;
  dialogDismissRequested = false;
  closeOverlay();
}

function resetOverlayPresentation() {
  sendDestinationConnectorId.value = undefined;
  draggable.modalPosition.x = 0;
  draggable.modalPosition.y = 0;
  dialogDismissRequested = false;
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
