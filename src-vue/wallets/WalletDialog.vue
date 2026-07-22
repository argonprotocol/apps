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
              :addWalletStep="props.transferIn.addWalletStep"
              :wallet="props.transferIn.wallet ? getWallet(props.transferIn.wallet) : undefined"
              :availableWallets="props.availableWallets"
              :isSource="true"
              :transferDirection="transferInConfig?.crosschainDirection"
              :moveFrom="transferInConfig?.moveFrom"
              :moveTo="transferInConfig?.moveTo"
              class="relative mt-7 -mr-px mb-7"
              @select="emit('selectTransferWallet', 'in', $event)"
              @closeWallet="emit('returnToTransferWalletChooser', 'in')"
              @cancelAddWallet="emit('returnToTransferWalletChooser', 'in')"
              @completeAddWallet="emit('completeAddWallet', 'in', $event)"
              @minimize="emit('toggleTransferDirection', 'in')"
              @addNewWallet="emit('addNewWallet', 'in')"
              @addExternalEthereum="emit('addExternalEthereum', 'in')"
              @openTransferOverlay="
                props.transferIn.wallet &&
                props.primaryWallet &&
                openTransferOverlay(props.transferIn.wallet, props.primaryWallet, $event)
              "
            />
          </Transition>

          <div class="relative z-20 flex w-120 shrink-0">
            <button
              v-if="props.primaryWallet && !props.transferIn"
              data-testid="WalletOverlay.toggleTransferIn()"
              type="button"
              class="absolute top-24 right-full flex h-84 w-14 cursor-pointer flex-col items-center justify-between gap-y-3 rounded-l-lg border border-r-0 border-black/80 bg-gray-300/80 py-10 text-lg font-bold text-black/40 shadow-lg hover:bg-gray-300 focus:outline-none"
              @click="emit('toggleTransferDirection', 'in')"
            >
              <ArrowRightIcon class="h-7 w-7" />
              <span class="rotate-180 [writing-mode:vertical-rl]">CLICK TO MOVE IN</span>
              <ArrowRightIcon class="h-7 w-7" />
            </button>
            <button
              v-if="props.primaryWallet && !props.transferOut"
              data-testid="WalletOverlay.toggleTransferOut()"
              type="button"
              class="absolute top-24 left-full flex h-84 w-14 cursor-pointer flex-col items-center justify-center gap-y-3 rounded-r-lg border border-l-0 border-black/80 bg-gray-300/80 text-lg font-bold text-black/40 shadow-lg hover:bg-gray-300 focus:outline-none"
              @click="emit('toggleTransferDirection', 'out')"
            >
              <ArrowRightIcon class="h-7 w-7" />
              <span class="[writing-mode:vertical-rl]">CLICK TO MOVE OUT</span>
              <ArrowRightIcon class="h-7 w-7" />
            </button>

            <section
              class="relative z-20 flex min-h-140 w-full flex-col overflow-visible rounded-lg border border-black/60 bg-white shadow-2xl"
            >
              <h2
                :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
                class="z-20 mx-2 flex shrink-0 items-center px-2 pt-3 pb-2 text-2xl font-bold text-slate-800/70 select-none"
                @mousedown="draggable.onMouseDown"
              >
                <NavHeader
                  v-if="props.primaryWallet"
                  :selection="props.primaryWallet"
                  :walletSelections="props.walletSelections"
                  :wallet="getWallet(props.primaryWallet)"
                  :canExportPrivateKey="canExportEthereumPrivateKey(props.primaryWallet)"
                  :showClose="true"
                  closeSide="right"
                  @select="emit('selectPrimaryWallet', $event)"
                  @close="emit('close')"
                />
                <div v-else class="flex min-w-0 grow items-center gap-x-2.5 pl-1.5">
                  <span class="min-w-0 grow truncate text-left text-xl font-bold text-slate-800/70">
                    Add Ethereum Wallet
                  </span>
                  <button
                    type="button"
                    class="relative z-10 flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
                    @click="emit('close')"
                  >
                    <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
                  </button>
                </div>
              </h2>
              <WalletPanel
                v-if="props.primaryWallet"
                :selection="props.primaryWallet"
                :wallet="getWallet(props.primaryWallet)"
                :mode="props.transferOut?.wallet ? 'transfer' : 'chooser'"
                :showGuidance="props.showGuidance"
                :guidanceContext="props.guidanceContext"
                :indentTokensLeft="!!props.transferIn?.wallet"
                :indentTokensRight="!!props.transferOut?.wallet"
                class="grow"
              />
              <EthereumWalletSetup
                v-else
                :initialStep="props.primaryAddWalletStep ?? 'external'"
                class="min-h-0 grow border-t border-slate-300"
                @complete="emit('completeAddWallet', 'primary', $event)"
              />
            </section>
          </div>

          <Transition name="wallet-sidecar-right">
            <WalletTransferSidecar
              v-if="props.transferOut"
              direction="out"
              :walletSelection="props.transferOut.wallet"
              :addWalletStep="props.transferOut.addWalletStep"
              :wallet="props.transferOut.wallet ? getWallet(props.transferOut.wallet) : undefined"
              :moveWallet="props.primaryWallet ? getWallet(props.primaryWallet) : undefined"
              :availableWallets="props.availableWallets"
              :isSource="false"
              :transferDirection="transferOutConfig?.crosschainDirection"
              :moveFrom="transferOutConfig?.moveFrom"
              :moveTo="transferOutConfig?.moveTo"
              class="relative mt-7 mb-7 -ml-px"
              @select="emit('selectTransferWallet', 'out', $event)"
              @closeWallet="emit('returnToTransferWalletChooser', 'out')"
              @cancelAddWallet="emit('returnToTransferWalletChooser', 'out')"
              @completeAddWallet="emit('completeAddWallet', 'out', $event)"
              @minimize="emit('toggleTransferDirection', 'out')"
              @addNewWallet="emit('addNewWallet', 'out')"
              @addExternalEthereum="emit('addExternalEthereum', 'out')"
              @openTransferOverlay="
                props.transferOut.wallet &&
                props.primaryWallet &&
                openTransferOverlay(props.primaryWallet, props.transferOut.wallet, $event)
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
import { ArrowRightIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { IArgonWalletType, IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
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
import EthereumWalletSetup from './EthereumWalletImportOverlay.vue';
import {
  getWalletSelectionKey,
  isEthereumWalletSelection,
  type IWalletSelection,
  type IWalletSetupStep,
  type IWalletTransferSideState,
  type IWalletTransferDirection,
} from './walletOverlayState.ts';

const props = defineProps<{
  primaryWallet?: IWalletSelection;
  primaryAddWalletStep?: IWalletSetupStep;
  transferIn?: IWalletTransferSideState;
  transferOut?: IWalletTransferSideState;
  walletSelections: IWalletSelection[];
  availableWallets: IWalletSelection[];
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
  (event: 'addExternalEthereum', direction: IWalletTransferDirection): void;
  (event: 'completeAddWallet', target: 'primary' | IWalletTransferDirection, walletRecord: IWalletRecord): void;
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
  props.transferIn?.wallet && props.primaryWallet
    ? getTransferConfig(props.transferIn.wallet, props.primaryWallet)
    : undefined,
);
const transferOutConfig = Vue.computed(() =>
  props.transferOut?.wallet && props.primaryWallet
    ? getTransferConfig(props.primaryWallet, props.transferOut.wallet)
    : undefined,
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
    props.primaryWallet ? getWalletSelectionKey(props.primaryWallet) : undefined,
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
