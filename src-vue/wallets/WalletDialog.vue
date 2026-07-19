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
          class="pointer-events-auto absolute flex min-h-140 items-stretch focus:outline-none"
          @mousedown="emit('focus')"
        >
          <DialogTitle class="sr-only">Wallet</DialogTitle>

          <Transition name="wallet-sidecar-left">
            <WalletTransferSidecar
              v-if="props.transferIn"
              direction="in"
              :walletSelection="props.transferIn.wallet"
              :wallet="props.transferIn.wallet ? getWallet(props.transferIn.wallet) : undefined"
              :availableWallets="props.availableWallets"
              :canAddDefaultEthereum="props.canAddDefaultEthereum"
              :isSource="true"
              :transferDirection="transferInConfig?.crosschainDirection"
              :moveFrom="transferInConfig?.moveFrom"
              :moveTo="transferInConfig?.moveTo"
              class="relative mt-7 -mr-px mb-7"
              @select="emit('selectTransferWallet', 'in', $event)"
              @closeWallet="emit('returnToTransferWalletChooser', 'in')"
              @minimize="emit('toggleTransferDirection', 'in')"
              @addNewWallet="emit('addNewWallet', 'in')"
              @addDefaultEthereum="emit('addDefaultEthereum', 'in')"
              @addExternalEthereum="emit('addExternalEthereum', 'in')"
              @openTransferOverlay="
                props.transferIn.wallet && openTransferOverlay(props.transferIn.wallet, props.primaryWallet, $event)
              "
            />
          </Transition>

          <section
            class="relative z-20 flex min-h-140 w-120 shrink-0 flex-col overflow-visible rounded-lg border border-black/40 bg-white shadow-2xl"
          >
            <button
              v-if="!props.transferIn"
              data-testid="WalletOverlay.toggleTransferIn()"
              type="button"
              class="absolute top-24 right-full flex h-76 w-14 cursor-pointer flex-col items-center justify-between rounded-l-lg border border-r-0 border-black/50 bg-gray-900/70 py-10 text-lg font-bold text-white/60 shadow-lg hover:bg-gray-900/90"
              @click="emit('toggleTransferDirection', 'in')"
            >
              <ArrowLeftIcon class="h-7 w-7" />
              <span class="rotate-180 [writing-mode:vertical-rl]">TRANSFER IN</span>
              <ArrowLeftIcon class="h-7 w-7" />
            </button>
            <button
              v-if="!props.transferOut"
              data-testid="WalletOverlay.toggleTransferOut()"
              type="button"
              class="absolute top-24 left-full flex h-76 w-14 cursor-pointer flex-col items-center justify-between rounded-r-lg border border-l-0 border-black/50 bg-gray-900/70 py-10 text-lg font-bold text-white/60 shadow-lg hover:bg-gray-900/90"
              @click="emit('toggleTransferDirection', 'out')"
            >
              <ArrowRightIcon class="h-7 w-7" />
              <span class="[writing-mode:vertical-rl]">TRANSFER OUT</span>
              <ArrowRightIcon class="h-7 w-7" />
            </button>

            <h2
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="z-20 mx-2 flex shrink-0 items-center px-2 pt-3 pb-2 text-2xl font-bold text-slate-800/70 select-none"
              @mousedown="draggable.onMouseDown"
            >
              <NavHeader
                :selection="props.primaryWallet"
                :walletSelections="props.walletSelections"
                :wallet="getWallet(props.primaryWallet)"
                :canExportPrivateKey="canExportEthereumPrivateKey(props.primaryWallet)"
                :showClose="true"
                closeSide="right"
                @select="emit('selectPrimaryWallet', $event)"
                @close="emit('close')"
              />
            </h2>
            <WalletPanel
              :selection="props.primaryWallet"
              :wallet="getWallet(props.primaryWallet)"
              :mode="props.transferOut?.wallet ? 'transfer' : 'chooser'"
              :showGuidance="props.showGuidance"
              :guidanceContext="props.guidanceContext"
              :indentTokensLeft="!!props.transferIn?.wallet"
              :indentTokensRight="!!props.transferOut?.wallet"
              class="grow"
            />
          </section>

          <Transition name="wallet-sidecar-right">
            <WalletTransferSidecar
              v-if="props.transferOut"
              direction="out"
              :walletSelection="props.transferOut.wallet"
              :wallet="props.transferOut.wallet ? getWallet(props.transferOut.wallet) : undefined"
              :moveWallet="getWallet(props.primaryWallet)"
              :availableWallets="props.availableWallets"
              :canAddDefaultEthereum="props.canAddDefaultEthereum"
              :isSource="false"
              :transferDirection="transferOutConfig?.crosschainDirection"
              :moveFrom="transferOutConfig?.moveFrom"
              :moveTo="transferOutConfig?.moveTo"
              class="relative mt-7 mb-7 -ml-px"
              @select="emit('selectTransferWallet', 'out', $event)"
              @closeWallet="emit('returnToTransferWalletChooser', 'out')"
              @minimize="emit('toggleTransferDirection', 'out')"
              @addNewWallet="emit('addNewWallet', 'out')"
              @addDefaultEthereum="emit('addDefaultEthereum', 'out')"
              @addExternalEthereum="emit('addExternalEthereum', 'out')"
              @openTransferOverlay="
                props.transferOut.wallet && openTransferOverlay(props.primaryWallet, props.transferOut.wallet, $event)
              "
            />
          </Transition>

          <WalletTransferOverlay :request="activeTransferOverlay" @close="activeTransferOverlay = undefined" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { ArrowLeftIcon, ArrowRightIcon } from '@heroicons/vue/24/outline';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { IArgonWalletType, IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { type IWallet, WalletType } from '../lib/Wallet.ts';
import Draggable from '../overlays/helpers/Draggable.ts';
import { getOverlayBackdropZIndex, provideOverlayContentZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import { useWallets } from '../stores/wallets.ts';
import type { IWalletGuidanceContext } from '../emitters/basicEmitter.ts';
import BgOverlay from '../components/BgOverlay.vue';
import NavHeader from './components/NavHeader.vue';
import WalletPanel from './components/WalletPanel.vue';
import WalletTransferOverlay from './components/WalletTransferOverlay.vue';
import WalletTransferSidecar from './components/WalletTransferSidecar.vue';
import {
  getWalletSelectionKey,
  isEthereumWalletSelection,
  type IWalletSelection,
  type IWalletTransferSideState,
  type IWalletTransferDirection,
} from './walletOverlayState.ts';

const props = defineProps<{
  primaryWallet: IWalletSelection;
  transferIn?: IWalletTransferSideState;
  transferOut?: IWalletTransferSideState;
  walletSelections: IWalletSelection[];
  availableWallets: IWalletSelection[];
  canAddDefaultEthereum: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
  zIndex: number;
}>();

const emit = defineEmits<{
  (event: 'focus'): void;
  (event: 'selectPrimaryWallet', wallet: IWalletSelection): void;
  (event: 'toggleTransferDirection', direction: IWalletTransferDirection): void;
  (event: 'selectTransferWallet', direction: IWalletTransferDirection, wallet: IWalletSelection): void;
  (event: 'returnToTransferWalletChooser', direction: IWalletTransferDirection): void;
  (event: 'addNewWallet', direction: IWalletTransferDirection): void;
  (event: 'addDefaultEthereum', direction: IWalletTransferDirection): void;
  (event: 'addExternalEthereum', direction: IWalletTransferDirection): void;
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

const transferInConfig = Vue.computed(() =>
  props.transferIn?.wallet ? getTransferConfig(props.transferIn.wallet, props.primaryWallet) : undefined,
);
const transferOutConfig = Vue.computed(() =>
  props.transferOut?.wallet ? getTransferConfig(props.primaryWallet, props.transferOut.wallet) : undefined,
);

function getTransferConfig(source: IWalletSelection, recipient: IWalletSelection) {
  if (isEthereumWalletSelection(source) && !isEthereumWalletSelection(recipient)) {
    return { crosschainDirection: 'transferToArgon' as const };
  }
  if (!isEthereumWalletSelection(source) && isEthereumWalletSelection(recipient)) {
    return { crosschainDirection: 'transferOutOfArgon' as const };
  }
  if (isEthereumWalletSelection(source) || isEthereumWalletSelection(recipient)) return;
  if (source.walletType === WalletType.defaultArgon && recipient.walletType === WalletType.miningBot) {
    return { moveFrom: MoveFrom.DefaultArgon, moveTo: MoveTo.MiningBot };
  }
  if (source.walletType === WalletType.miningBot && recipient.walletType === WalletType.defaultArgon) {
    return { moveFrom: MoveFrom.MiningBot, moveTo: MoveTo.DefaultArgon };
  }
}

provideOverlayContentZIndex(Vue.computed(() => props.zIndex));

function getWallet(selection: IWalletSelection): IWallet {
  if (isEthereumWalletSelection(selection)) return walletStore.getEthereumWalletRecord(selection.walletRecord.id);
  return selection.walletType === WalletType.miningBot ? walletStore.miningBotWallet : walletStore.defaultArgonWallet;
}

function canExportEthereumPrivateKey(selection: IWalletSelection) {
  return isEthereumWalletSelection(selection) && selection.walletRecord.role === 'defaultEthereum';
}

async function openTransferOverlay(
  sourceWallet: IWalletSelection,
  recipientWallet: IWalletSelection,
  transfer: { moveToken: IEthereumMoveToken; availableAmount: bigint },
) {
  const direction = getTransferConfig(sourceWallet, recipientWallet)?.crosschainDirection;
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
    getWalletSelectionKey(props.primaryWallet),
    props.transferIn?.wallet ? getWalletSelectionKey(props.transferIn.wallet) : undefined,
    props.transferOut?.wallet ? getWalletSelectionKey(props.transferOut.wallet) : undefined,
  ],
  () => {
    activeTransferOverlay.value = undefined;
  },
);
</script>

<style scoped>
.wallet-sidecar-left-enter-active,
.wallet-sidecar-left-leave-active,
.wallet-sidecar-right-enter-active,
.wallet-sidecar-right-leave-active {
  transition:
    transform 180ms ease,
    opacity 180ms ease;
}

.wallet-sidecar-left-enter-from,
.wallet-sidecar-left-leave-to {
  transform: translateX(60px);
  opacity: 0;
}

.wallet-sidecar-right-enter-from,
.wallet-sidecar-right-leave-to {
  transform: translateX(-60px);
  opacity: 0;
}
</style>
