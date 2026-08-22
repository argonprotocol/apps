<template>
  <DialogRoot :open="true" :modal="true" @update:open="handleDialogOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay
          class="bg-black/40"
          :style="{ zIndex: getOverlayBackdropZIndex(props.zIndex) }"
          :blurContent="true"
          @pointerdown.capture="dialogDismissRequested = false"
          @close="closeFromBackdrop"
        />
      </DialogOverlay>
      <DialogContent
        :aria-describedby="undefined"
        :style="{ zIndex: props.zIndex }"
        @escapeKeyDown.prevent="emit('close')"
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
          @mousedown="emit('focus')"
        >
          <div>
            <div
              :class="props.centerView.type !== 'addEthereum' ? 'bg-neutral-600' : ''"
              class="relative z-20 flex h-full w-120 shrink-0 p-2"
            >
              <svg
                v-if="props.centerView.type !== 'addEthereum'"
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
                :class="activeConnectorId ? 'bg-neutral-200' : 'bg-white'"
                class="absolute top-2 right-2 bottom-2 left-2 rounded-lg border border-black/60 shadow-sm/30"
              />
              <section
                :class="activeConnectorId ? 'pointer-events-none opacity-70' : ''"
                class="relative w-full overflow-visible"
              >
                <WalletViewMain
                  v-if="props.centerView.type === 'main'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="props.showGuidance"
                  :guidanceContext="props.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="emit('goto', $event)"
                  @close="emit('close')"
                />
                <WalletViewSend
                  v-else-if="props.centerView.type === 'send'"
                  :isDragging="draggable.isDragging"
                  :activeConnector="props.activeConnector"
                  :showGuidance="props.showGuidance"
                  :guidanceContext="props.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @selectDestinationConnector="selectSendDestinationConnector"
                  @goto="emit('goto', $event)"
                  @close="emit('close')"
                />
                <WalletViewReceive
                  v-else-if="props.centerView.type === 'receive'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="props.showGuidance"
                  :guidanceContext="props.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="emit('goto', $event)"
                  @close="emit('close')"
                />
                <WalletViewPrivateKey
                  v-else-if="props.centerView.type === 'privateKey'"
                  :isDragging="draggable.isDragging"
                  :showGuidance="props.showGuidance"
                  :guidanceContext="props.guidanceContext"
                  @dragStart="draggable.onMouseDown($event)"
                  @goto="emit('goto', $event)"
                  @close="emit('close')"
                />
                <WalletViewAddConnector
                  v-else
                  :initialStep="props.centerView.initialStep"
                  :isDragging="draggable.isDragging"
                  @dragStart="draggable.onMouseDown($event)"
                  @close="emit('closeAddConnector')"
                  @complete="emit('completeAddConnector', $event)"
                />
              </section>
            </div>
            <section
              v-if="props.centerView.type !== 'addEthereum'"
              class="absolute top-0 right-full flex h-full flex-col justify-between py-5"
            >
              <article
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== 'bitcoin'
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <Connector
                  network="bitcoin"
                  direction="left"
                  :open="props.activeConnector?.network === 'bitcoin'"
                  @update:open="updateBitcoinConnector($event)"
                />
                <svg aria-hidden="true" class="relative mx-1 h-1 w-40 text-neutral-400/80 shadow-sm/40">
                  <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
                </svg>
              </article>
              <article
                v-for="selection of leftExternalConnectors"
                :key="selection.walletRecord.id"
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== selection.walletRecord.id
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <Connector
                  network="ethereum"
                  direction="left"
                  :selection="selection"
                  :open="isEthereumConnectorOpen(selection.walletRecord.id)"
                  :transferDirections="getTransferDirections(selection.walletRecord.id)"
                  @update:open="updateEthereumConnector(selection.walletRecord.id, $event)"
                />
                <ConnectorTransferActivity
                  side="left"
                  :transferDirections="getTransferDirections(selection.walletRecord.id)"
                />
              </article>
              <article
                v-for="slot in 2 - leftExternalConnectors.length"
                :key="`left-external-connector-${slot}`"
                :class="connectorSelectionIsActive ? 'pointer-events-none opacity-20' : ''"
                class="flex flex-row items-center"
              >
                <Connector :network="undefined" direction="left" :open="false" @addConnector="emit('addConnector')" />
                <svg aria-hidden="true" class="relative mx-1 h-1 w-40 text-neutral-400/80 shadow-sm/40">
                  <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
                </svg>
              </article>
            </section>

            <section
              v-if="props.centerView.type !== 'addEthereum'"
              class="absolute top-0 left-full flex h-full flex-col justify-between py-5"
            >
              <article
                v-for="selection of rightExternalConnectors"
                :key="selection.walletRecord.id"
                :class="
                  connectorSelectionIsActive && highlightedConnectorId !== selection.walletRecord.id
                    ? 'pointer-events-none opacity-20'
                    : ''
                "
                class="flex flex-row items-center"
              >
                <ConnectorTransferActivity
                  side="right"
                  :transferDirections="getTransferDirections(selection.walletRecord.id)"
                />
                <Connector
                  network="ethereum"
                  direction="right"
                  :selection="selection"
                  :open="isEthereumConnectorOpen(selection.walletRecord.id)"
                  :transferDirections="getTransferDirections(selection.walletRecord.id)"
                  @update:open="updateEthereumConnector(selection.walletRecord.id, $event)"
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
                <Connector :network="undefined" direction="right" :open="false" @addConnector="emit('addConnector')" />
              </article>
            </section>
          </div>
        </div>
        <WalletBottomBar
          v-if="props.centerView.type !== 'addEthereum'"
          :class="activeConnectorId ? 'opacity-30' : ''"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'reka-ui';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { getEthereumMoveTracker } from '../stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../stores/moveToEthereum.ts';
import Draggable from '../overlays/helpers/Draggable.ts';
import { getOverlayBackdropZIndex, provideOverlayContentZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import type { IWalletGuidanceContext } from '../emitters/basicEmitter.ts';
import BgOverlay from '../components/BgOverlay.vue';
import WalletViewAddConnector from './components/WalletViewAddConnector.vue';
import WalletViewMain from './components/WalletViewMain.vue';
import WalletViewPrivateKey from './components/WalletViewPrivateKey.vue';
import WalletViewReceive from './components/WalletViewReceive.vue';
import WalletViewSend from './components/WalletViewSend.vue';
import {
  isEthereumWalletSelection,
  type IWalletConnectorTarget,
  type IWalletOverlayCenterView,
  type IWalletSelection,
  type IWalletView,
} from './walletOverlayState.ts';
import WalletBottomBar from './components/WalletBottomBar.vue';
import Connector from './components/Connector.vue';
import ConnectorTransferActivity from './components/ConnectorTransferActivity.vue';
import { isCrosschainTransferActive, type ICrosschainTransferDirection } from './components/crosschainTransferView.ts';

const props = defineProps<{
  centerView: IWalletOverlayCenterView;
  activeConnector?: IWalletConnectorTarget;
  walletSelections: IWalletSelection[];
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
  zIndex: number;
}>();

const emit = defineEmits<{
  (event: 'focus'): void;
  (event: 'updateActiveConnector', target: IWalletConnectorTarget | undefined): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'addConnector'): void;
  (event: 'closeAddConnector'): void;
  (event: 'completeAddConnector', walletRecord: IWalletRecord): void;
  (event: 'close'): void;
}>();

const sendDestinationConnectorId = Vue.ref<string | number>();
const activeConnectorId = Vue.computed<string | number | undefined>(() => {
  if (props.activeConnector?.network === 'bitcoin') return 'bitcoin';
  return props.activeConnector?.walletRecordId;
});
const connectorSelectionIsActive = Vue.computed(
  () => activeConnectorId.value !== undefined || props.centerView.type === 'send',
);
const highlightedConnectorId = Vue.computed(() => {
  if (activeConnectorId.value !== undefined) return activeConnectorId.value;
  return props.centerView.type === 'send' ? sendDestinationConnectorId.value : undefined;
});
const draggable = Vue.reactive(new Draggable({ constrainToViewport: false }));
const inboundTracker = getEthereumMoveTracker();
const outboundTracker = getEthereumOutboundTransferTracker();
const externalConnectors = Vue.computed(() => props.walletSelections.filter(isEthereumWalletSelection));
const leftExternalConnectors = Vue.computed(() => {
  return externalConnectors.value.filter((_, index) => index % 2 === 1).slice(0, 2);
});
const rightExternalConnectors = Vue.computed(() => {
  return externalConnectors.value.filter((_, index) => index % 2 === 0).slice(0, 3);
});
const activeTransferDirectionsByWalletRecordId = Vue.computed(() => {
  const walletRecordIdByAddress = new Map(
    externalConnectors.value.map(selection => [
      selection.walletRecord.address.toLowerCase(),
      selection.walletRecord.id,
    ]),
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

provideOverlayContentZIndex(Vue.computed(() => props.zIndex));

function isEthereumConnectorOpen(walletRecordId: number) {
  return props.activeConnector?.network === 'ethereum' && props.activeConnector.walletRecordId === walletRecordId;
}

function getTransferDirections(walletRecordId: number) {
  return activeTransferDirectionsByWalletRecordId.value.get(walletRecordId) ?? [];
}

function selectSendDestinationConnector(connectorId: string | number | undefined) {
  sendDestinationConnectorId.value = connectorId;
}

function updateBitcoinConnector(isOpen: boolean) {
  emit('updateActiveConnector', isOpen ? { network: 'bitcoin' } : undefined);
}

function updateEthereumConnector(walletRecordId: number, isOpen: boolean) {
  emit('updateActiveConnector', isOpen ? { network: 'ethereum', walletRecordId } : undefined);
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
  emit('close');
}
</script>
