<template>
  <DialogRoot :open="true" :modal="true">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay
          class="bg-black/30"
          :style="{ zIndex: getOverlayBackdropZIndex(props.zIndex) }"
          @close="emit('close')"
        />
      </DialogOverlay>
      <DialogContent
        asChild
        :aria-describedby="undefined"
        :style="{ zIndex: props.zIndex }"
        @escapeKeyDown.prevent="emit('close')"
      >
        <div
          :ref="setWalletRef"
          data-testid="WalletOverlay"
          :style="{
            top: `calc(50% + ${draggable.modalPosition.y}px)`,
            left: `calc(50% + ${draggable.modalPosition.x}px)`,
            transform: 'translate(-50%, -50%)',
          }"
          class="pointer-events-auto absolute flex min-h-140 flex-row gap-12 focus:outline-none"
          @mousedown="emit('focus')"
        >
          <DialogTitle class="sr-only">Wallets</DialogTitle>

          <section
            class="flex min-h-140 w-110 shrink-0 flex-col rounded-lg"
            :class="
              props.leftWallet
                ? 'overflow-visible border border-black/40 bg-white shadow-2xl'
                : 'overflow-hidden border-2 border-dashed border-slate-400/80 bg-gray-200/95 inset-shadow-sm inset-shadow-slate-300/60'
            "
          >
            <h2
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="z-20 mx-2 flex shrink-0 flex-row items-center justify-between gap-x-3 px-2 pt-3 pb-2 text-2xl font-bold text-slate-800/70 select-none"
              @mousedown="draggable.onMouseDown"
            >
              <NavHeader
                v-if="props.leftWallet"
                :selection="props.leftWallet"
                :walletSelections="props.walletSelections"
                :wallet="getWallet(props.leftWallet)"
                :canExportPrivateKey="canExportEthereumPrivateKey(props.leftWallet)"
                :showClose="true"
                closeSide="left"
                @select="emit('selectLeftWallet', $event)"
                @close="emit('closeLeft')"
              />
              <header v-else class="grow px-2 text-left text-xl font-bold text-slate-600">Choose a Wallet</header>
            </h2>

            <WalletPanel
              v-if="props.leftWallet"
              :selection="props.leftWallet"
              :wallet="getWallet(props.leftWallet)"
              :mode="props.rightWallet ? 'transfer' : 'chooser'"
              :transferDirection="
                props.rightWallet ? getTransferDirection(props.leftWallet, props.rightWallet) : undefined
              "
              :moveFrom="argonWalletMove?.moveFrom"
              :moveTo="argonWalletMove?.moveTo"
              :showGuidance="props.showGuidance"
              :guidanceContext="props.guidanceContext"
              class="grow"
              @openTransferOverlay="
                props.rightWallet && openTransferOverlay(props.leftWallet, props.rightWallet, $event)
              "
            />
            <WalletChooser
              v-else
              :availableWallets="props.availableWallets"
              :canAddDefaultEthereum="props.canAddDefaultEthereum"
              class="grow border-t border-dashed border-slate-400/50"
              @select="emit('selectLeftWallet', $event)"
              @addDefaultEthereum="emit('addDefaultEthereum', 'left')"
              @addExternalEthereum="emit('addExternalEthereum', 'left')"
            />
          </section>

          <section
            class="flex min-h-140 w-110 shrink-0 flex-col rounded-lg"
            :class="
              props.rightWallet
                ? 'overflow-visible border border-black/40 bg-white shadow-2xl'
                : 'overflow-hidden border-2 border-dashed border-slate-400/60 bg-slate-100/90 inset-shadow-sm inset-shadow-slate-300/60'
            "
          >
            <h2
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="z-20 mx-2 flex shrink-0 flex-row items-center justify-between gap-x-3 px-2 pt-3 pb-2 text-2xl font-bold text-slate-800/70 select-none"
              @mousedown="draggable.onMouseDown"
            >
              <NavHeader
                v-if="props.rightWallet"
                :selection="props.rightWallet"
                :walletSelections="props.walletSelections"
                :wallet="getWallet(props.rightWallet)"
                :canExportPrivateKey="canExportEthereumPrivateKey(props.rightWallet)"
                :showClose="true"
                closeSide="right"
                @select="emit('selectRightWallet', $event)"
                @close="emit('closeRight')"
              />
              <header v-else class="grow px-2 text-left text-xl font-bold text-slate-600">Choose a Wallet</header>
            </h2>

            <WalletPanel
              v-if="props.rightWallet"
              :selection="props.rightWallet"
              :wallet="getWallet(props.rightWallet)"
              :mode="props.leftWallet ? 'transfer' : 'chooser'"
              :showGuidance="props.showGuidance"
              :guidanceContext="props.guidanceContext"
              class="grow"
            />
            <WalletChooser
              v-else
              :availableWallets="props.availableWallets"
              :canAddDefaultEthereum="props.canAddDefaultEthereum"
              class="grow border-t border-dashed border-slate-400/50"
              @select="emit('selectRightWallet', $event)"
              @addDefaultEthereum="emit('addDefaultEthereum', 'right')"
              @addExternalEthereum="emit('addExternalEthereum', 'right')"
            />
          </section>

          <div
            v-if="props.leftWallet && props.rightWallet"
            class="absolute top-full left-1/2 mt-4 flex w-max max-w-4xl -translate-x-1/2 items-center gap-3 text-sm text-white drop-shadow-sm"
          >
            <button
              data-testid="WalletOverlay.toggleSyncDirection()"
              type="button"
              class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded border border-white/50 bg-white/10 px-3 py-1.5 font-semibold text-white hover:bg-white/20 focus:outline-none"
              title="Switch direction"
              @click="emit('flip')"
            >
              <ArrowsRightLeftIcon class="h-4 w-4 stroke-2" />
              Switch direction
            </button>
            <p>
              Use
              <strong>{{ isCrosschainWalletPair() ? 'JUMP' : 'MOVE' }}</strong>
              to transfer supported tokens from
              <strong>{{ getWalletSelectionName(props.leftWallet) }}</strong>
              to
              <strong>{{ getWalletSelectionName(props.rightWallet) }}</strong>
              .
              <a
                v-if="isCrosschainWalletPair()"
                href="https://argon.network/documentation/transfer-guide"
                target="_blank"
                class="font-semibold underline"
              >
                Learn more
              </a>
            </p>
          </div>

          <WalletTransferOverlay :request="activeTransferOverlay" @close="activeTransferOverlay = undefined" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { ArrowsRightLeftIcon } from '@heroicons/vue/24/outline';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { IArgonWalletType, IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { type IWallet, WalletType } from '../lib/Wallet.ts';
import Draggable from '../overlays/helpers/Draggable.ts';
import { getOverlayBackdropZIndex, provideOverlayContentZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import { useWallets } from '../stores/wallets.ts';
import type { IWalletGuidanceContext } from '../emitters/basicEmitter.ts';
import BgOverlay from '../components/BgOverlay.vue';
import NavHeader from './components/NavHeader.vue';
import WalletChooser from './components/WalletChooser.vue';
import WalletPanel from './components/WalletPanel.vue';
import WalletTransferOverlay from './components/WalletTransferOverlay.vue';
import {
  getWalletSelectionKey,
  getWalletSelectionName,
  isEthereumWalletSelection,
  type IWalletSelection,
} from './walletOverlayState.ts';

const props = withDefaults(
  defineProps<{
    leftWallet?: IWalletSelection;
    rightWallet?: IWalletSelection;
    walletSelections: IWalletSelection[];
    availableWallets: IWalletSelection[];
    canAddDefaultEthereum: boolean;
    showGuidance?: boolean;
    guidanceContext?: IWalletGuidanceContext;
    zIndex: number;
  }>(),
  {
    showGuidance: false,
  },
);

const emit = defineEmits<{
  (event: 'focus'): void;
  (event: 'selectLeftWallet', wallet: IWalletSelection): void;
  (event: 'selectRightWallet', wallet: IWalletSelection): void;
  (event: 'addDefaultEthereum', side: 'left' | 'right'): void;
  (event: 'addExternalEthereum', side: 'left' | 'right'): void;
  (event: 'flip'): void;
  (event: 'closeLeft'): void;
  (event: 'closeRight'): void;
  (event: 'close'): void;
}>();

const walletStore = useWallets();
const draggable = Vue.reactive(new Draggable({ constrainToViewport: false }));
const activeTransferOverlay = Vue.ref<{
  direction: 'transferToArgon' | 'transferOutOfArgon';
  moveToken: IEthereumMoveToken;
  availableAmount: bigint;
  walletType: IArgonWalletType;
  networkName: string;
  feeTokenSymbol: string;
}>();
const argonWalletMove = Vue.computed(() => {
  const sourceWallet = props.leftWallet;
  const recipientWallet = props.rightWallet;
  if (
    !sourceWallet ||
    !recipientWallet ||
    isEthereumWalletSelection(sourceWallet) ||
    isEthereumWalletSelection(recipientWallet)
  ) {
    return;
  }

  if (sourceWallet.walletType === WalletType.defaultArgon && recipientWallet.walletType === WalletType.miningBot) {
    return { moveFrom: MoveFrom.DefaultArgon, moveTo: MoveTo.MiningBot };
  }

  if (sourceWallet.walletType === WalletType.miningBot && recipientWallet.walletType === WalletType.defaultArgon) {
    return { moveFrom: MoveFrom.MiningBot, moveTo: MoveTo.DefaultArgon };
  }
});

provideOverlayContentZIndex(Vue.computed(() => props.zIndex));

function getWallet(selection: IWalletSelection): IWallet {
  if (isEthereumWalletSelection(selection)) {
    return walletStore.getEthereumWalletRecord(selection.walletRecord.id);
  }

  return selection.walletType === WalletType.miningBot ? walletStore.miningBotWallet : walletStore.defaultArgonWallet;
}

function canExportEthereumPrivateKey(selection: IWalletSelection) {
  return isEthereumWalletSelection(selection) && selection.walletRecord.role === 'defaultEthereum';
}

function isCrosschainWalletPair() {
  if (!props.leftWallet || !props.rightWallet) return false;

  return isEthereumWalletSelection(props.leftWallet) !== isEthereumWalletSelection(props.rightWallet);
}

function getTransferDirection(
  sourceWallet: IWalletSelection,
  recipientWallet: IWalletSelection,
): 'transferToArgon' | 'transferOutOfArgon' | undefined {
  if (isEthereumWalletSelection(sourceWallet) && !isEthereumWalletSelection(recipientWallet)) {
    return 'transferToArgon';
  }

  if (!isEthereumWalletSelection(sourceWallet) && isEthereumWalletSelection(recipientWallet)) {
    return 'transferOutOfArgon';
  }
}

async function openTransferOverlay(
  sourceWallet: IWalletSelection,
  recipientWallet: IWalletSelection,
  transfer: { moveToken: IEthereumMoveToken; availableAmount: bigint },
) {
  const direction = getTransferDirection(sourceWallet, recipientWallet);
  if (!direction) return;

  const ethereumWallet = isEthereumWalletSelection(sourceWallet) ? sourceWallet : recipientWallet;
  const argonWallet = isEthereumWalletSelection(sourceWallet) ? recipientWallet : sourceWallet;
  if (!isEthereumWalletSelection(ethereumWallet) || isEthereumWalletSelection(argonWallet)) return;

  await walletStore.selectEthereumWalletRecord(ethereumWallet.walletRecord.id);
  activeTransferOverlay.value = {
    direction,
    moveToken: transfer.moveToken,
    availableAmount: transfer.availableAmount,
    walletType: argonWallet.walletType,
    networkName: 'Ethereum',
    feeTokenSymbol: 'ETH',
  };
}

function setWalletRef(element: Element | Vue.ComponentPublicInstance | null) {
  draggable.setModalRef(element);
}

Vue.watch(
  () => [
    props.leftWallet ? getWalletSelectionKey(props.leftWallet) : undefined,
    props.rightWallet ? getWalletSelectionKey(props.rightWallet) : undefined,
  ],
  () => {
    activeTransferOverlay.value = undefined;
  },
);
</script>
