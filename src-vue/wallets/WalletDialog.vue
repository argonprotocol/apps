<!-- prettier-ignore -->
<template>
  <DialogRoot :open="true" :modal="true">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay :style="{ zIndex: getOverlayBackdropZIndex(props.zIndex) }" @close="closeOverlay" />
      </DialogOverlay>
      <DialogContent
        asChild
        :aria-describedby="undefined"
        :style="{ zIndex: props.zIndex }"
        @escapeKeyDown.prevent="handlePressEsc"
      >
        <div
          :ref="setWalletRef"
          :style="{
            top: `calc(50% + ${draggable.modalPosition.y}px)`,
            left: `calc(50% + ${draggable.modalPosition.x}px)`,
            transform: 'translate(-50%, -50%)',
            cursor: draggable.isDragging ? 'grabbing' : 'default',
          }"
          :class="[
            isSyncMode ? 'w-220' : 'w-110',
            'absolute flex min-h-140 flex-col overflow-visible rounded-lg bg-linear-to-b from-[#cccccc] to-[#9f9f9f] shadow-2xl focus:outline-none pointer-events-auto',
          ]"
          @mousedown="emit('focus')"
        >
          <DialogTitle asChild>
            <h2
              class="z-20 mx-2 flex shrink-0 select-none flex-row items-center justify-between gap-x-3 px-2 pb-2 pt-3 text-2xl font-bold text-slate-800/70"
              @dblclick="handleHeaderDoubleClick"
              @mousedown="startDrag"
            >
              <div class="flex grow flex-row items-center">
                <div v-if="isSyncMode" class="w-1/2 flex flex-row pr-6">
                  <NavHeader :key="secondWalletKey" :walletType="secondWalletOption.type" :wallet="getWallet(secondWalletOption)" :isSyncMode="isSyncMode" :options="secondWalletOptions" :selectedOption="secondWalletOption" :showClose="true" @selectOption="handleSelectSecondWallet" @triggerSyncMode="triggerSyncMode" @close="closeOverlay" />
                </div>
                <div v-if="isSyncMode" class="relative h-[34px] w-[44px]">
                  <button
                    data-testid="WalletOverlay.toggleSyncDirection()"
                    type="button"
                    class="absolute top-1/2 left-1/2 -translate-1/2 z-10 flex h-[64px] w-[64px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-white border border-slate-500/60 shadow-sm text-slate-500/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
                    @click="toggleSyncDirection"
                  >
                    <PortalIcon class="h-8 w-8" />
                  </button>
                </div>
                <div :class="[isSyncMode ? 'w-1/2 pl-4' : 'w-full']" class="flex flex-row">
                  <NavHeader :key="firstWalletKey" :walletType="firstWalletOption.type" :wallet="getWallet(firstWalletOption)" :isSyncMode="isSyncMode" :options="firstWalletOptions" :selectedOption="firstWalletOption" :showClose="true" @selectOption="handleSelectFirstWallet" @triggerSyncMode="triggerSyncMode" @close="closeOverlay" />
                </div>
              </div>
            </h2>
          </DialogTitle>

          <div
            :class="[isSyncMode ? 'w-1/2' : 'w-full']"
            class="absolute left-0 top-0 z-[-1] h-full rounded-lg border border-black/40 bg-white"
          />
          <div
            v-if="isSyncMode"
            class="absolute right-0 top-0 z-[-1] h-full w-1/2 rounded-lg border border-black/40 bg-white"
          />

          <div class="flex w-full flex-row text-black/90 px-1 text-7xl font-bold text-center">
            <div v-if="isSyncMode" class="w-1/2 border-t border-slate-300 px-4 py-6">
              <FormattedMoney :value="getWallet(secondWalletOption).availableMicrogons" />
            </div>
            <div class="border-t border-slate-300 px-4 py-6" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
              <FormattedMoney :value="getWallet(firstWalletOption).availableMicrogons" />
            </div>
          </div>

          <div class="relative flex w-full flex-row" :class="isSyncMode ? 'py-2' : ''">
            <div v-if="isSyncMode" class="absolute -left-2 top-0 z-[-1] h-full w-[calc(100%+16px)] rounded-t-lg border border-black/30 bg-white shadow-md">
              <WrapBehindEdge class="absolute bottom-0 right-0 h-2 w-2 translate-y-full" />
              <WrapBehindEdge class="absolute bottom-0 left-0 h-2 w-2 translate-y-full scale-x-[-1]" />
            </div>
            <div v-if="isSyncMode" class="w-1/2 px-4">
              <ArgonTokens
                :microgons="getWallet(secondWalletOption).availableMicrogons"
                :micronots="getWallet(secondWalletOption).availableMicronots"
                :minimizedLines="true"
                :moveDirection="getTransferDirection(secondWalletOption, firstWalletOption)"
                :networkName="getExternalNetworkName(secondWalletOption, firstWalletOption)"
                :feeTokenSymbol="getExternalFeeTokenSymbol(secondWalletOption, firstWalletOption)"
                @openTransferOverlay="openTransferOverlay(secondWalletOption, firstWalletOption, $event.moveToken, $event.availableAmount)"
              />
            </div>
            <div class="px-4" :class="[isSyncMode ? 'w-1/2' : 'w-full']">
              <ArgonTokens
                :microgons="getWallet(firstWalletOption).availableMicrogons"
                :micronots="getWallet(firstWalletOption).availableMicronots"
                :minimizedLines="isSyncMode"
              />
            </div>
          </div>

          <div class="flex w-full grow flex-row">
            <div v-if="isSyncMode" class="flex w-1/2 flex-col px-4">
              <ArgonBottom
                v-if="isArgonWalletType(secondWalletOption.type)"
                :isSyncMode="isSyncMode"
                :showGuidance="props.showGuidance"
                :guidanceContext="props.guidanceContext"
                :walletType="secondWalletOption.type"
                direction="to"
              />
              <EthereumBottom v-else-if="secondWalletOption.type === 'ethereum'" />
            </div>
            <div :class="[isSyncMode ? 'w-1/2' : 'w-full']" class="flex flex-col px-4" >
              <ArgonBottom
                v-if="isArgonWalletType(firstWalletOption.type)"
                :isSyncMode="isSyncMode"
                :showGuidance="props.showGuidance"
                :guidanceContext="props.guidanceContext"
                :walletType="firstWalletOption.type"
                direction="from"
              />
              <EthereumBottom v-else-if="firstWalletOption.type === 'ethereum'" />
            </div>
          </div>

          <WalletTransferOverlay :request="activeTransferOverlay" @close="activeTransferOverlay = undefined" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from '../overlays/helpers/Draggable.ts';
import { getOverlayBackdropZIndex, provideOverlayContentZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import ArgonBottom from './components/ArgonBottom.vue';
import EthereumBottom from './components/EthereumBottom.vue';
import NavHeader, { type IWalletOption } from './components/NavHeader.vue';
import ArgonTokens from './components/ArgonTokens.vue';
import ArgonIntro from './components/ArgonIntro.vue';
import PortalIcon from '../assets/wallets/swap.svg';
import WrapBehindEdge from '../assets/wrap-behind-edge.svg';
import EthereumIntro from './components/EthereumIntro.vue';
import WalletTransferOverlay from './components/WalletTransferOverlay.vue';
import type { IArgonWalletType, IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { type IWallet, WalletType } from '../lib/Wallet.ts';
import { useWallets } from '../stores/wallets.ts';
import type { IWalletGuidanceContext } from '../emitters/basicEmitter.ts';
import FormattedMoney from '../components/FormattedMoney.vue';

const props = withDefaults(
  defineProps<{
    walletType: WalletType.defaultArgon | WalletType.ethereum;
    pairedWalletType?: WalletType.defaultArgon | WalletType.ethereum;
    showGuidance?: boolean;
    guidanceContext?: IWalletGuidanceContext;
    zIndex: number;
    position?: { x: number; y: number };
  }>(),
  {
    showGuidance: false,
    position: () => ({ x: 0, y: 0 }),
  },
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'focus'): void;
  (e: 'unpair'): void;
  (e: 'pair', pairedWalletType: WalletType.defaultArgon | WalletType.ethereum): void;
  (e: 'dragMove', payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }): void;
  (e: 'positionChange', payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }): void;
  (e: 'dragEnd', payload: { position: { x: number; y: number }; rect: DOMRectReadOnly }): void;
}>();

const walletStore = useWallets();
const draggable = Vue.reactive(new Draggable({ constrainToViewport: false }));
const walletRef = Vue.shallowRef<HTMLElement | null>(null);
provideOverlayContentZIndex(Vue.computed(() => props.zIndex));

const isSyncMode = Vue.computed(() => !!props.pairedWalletType);
const activeTransferOverlay = Vue.ref<{
  direction: 'transferToArgon' | 'transferOutOfArgon';
  moveToken: IEthereumMoveToken;
  availableAmount: bigint;
  walletType: IArgonWalletType;
  networkName: string;
  feeTokenSymbol: string;
}>();
const walletOptions = Vue.ref<IWalletOption[]>([
  { type: WalletType.defaultArgon as const, name: 'Native Argon Wallet', isArgonNetwork: true },
  { type: WalletType.ethereum as const, name: 'Native Ethereum Wallet', isArgonNetwork: false },
]);
const firstWalletOption = Vue.ref<IWalletOption>(getWalletOption(props.walletType));
const secondWalletOption = Vue.ref<IWalletOption>(
  props.pairedWalletType
    ? getWalletOption(props.pairedWalletType)
    : walletOptions.value[walletOptions.value.length - 1],
);
const firstWalletOptions = Vue.computed(() => getWalletOptionsForSide(secondWalletOption.value));
const secondWalletOptions = Vue.computed(() => getWalletOptionsForSide(firstWalletOption.value));
const firstWalletKey = Vue.computed(() => getWalletHeaderKey(firstWalletOption.value, firstWalletOptions.value));
const secondWalletKey = Vue.computed(() => getWalletHeaderKey(secondWalletOption.value, secondWalletOptions.value));

function isArgonWalletType(walletType: WalletType): walletType is WalletType.defaultArgon {
  return walletType === WalletType.defaultArgon;
}

function getWalletOptionsForSide(oppositeOption: IWalletOption) {
  if (!isSyncMode.value) return walletOptions.value;

  return walletOptions.value.filter(wallet => wallet.isArgonNetwork !== oppositeOption.isArgonNetwork);
}

function getWalletHeaderKey(selectedOption: IWalletOption, options: IWalletOption[]) {
  return `${selectedOption.type}:${options.map(wallet => wallet.type).join(',')}`;
}

function getWalletOption(walletType: WalletType) {
  const walletOption = walletOptions.value.find(x => x.type === walletType);
  if (!walletOption) {
    throw new Error(`Wallet option not supported: ${walletType}`);
  }
  return walletOption;
}

function closeOverlay() {
  activeTransferOverlay.value = undefined;
  emit('close');
}

function handlePressEsc() {
  if (!isSyncMode.value) {
    closeOverlay();
    return;
  }

  activeTransferOverlay.value = undefined;
  emit('unpair');
}

function handleHeaderDoubleClick() {
  if (!isSyncMode.value) return;
  activeTransferOverlay.value = undefined;
  emit('unpair');
}

function handleSelectFirstWallet(option: IWalletOption) {
  if (option.type === secondWalletOption.value.type) {
    secondWalletOption.value = firstWalletOption.value;
  }
  firstWalletOption.value = option;
}

function handleSelectSecondWallet(option: IWalletOption) {
  if (option.type === firstWalletOption.value.type) {
    firstWalletOption.value = secondWalletOption.value;
  }
  secondWalletOption.value = option;
}

function toggleSyncDirection() {
  activeTransferOverlay.value = undefined;
  const nextSecondWallet = firstWalletOption.value;
  firstWalletOption.value = secondWalletOption.value;
  secondWalletOption.value = nextSecondWallet;
}

function triggerSyncMode() {
  if (isSyncMode.value) return;
  emit('pair', firstWalletOption.value.isArgonNetwork ? WalletType.ethereum : getDefaultArgonWalletType());
}

function getDefaultArgonWalletType(): WalletType.defaultArgon {
  return WalletType.defaultArgon;
}

function getWallet(option: IWalletOption): IWallet {
  if (option.type === WalletType.ethereum) {
    return walletStore.ethereumWallet;
  } else if (option.type === WalletType.defaultArgon) {
    return walletStore.defaultArgonWallet;
  } else {
    throw new Error(`Wallet not support: ${option.type}`);
  }
}

function getTransferDirection(
  currentOption: IWalletOption,
  oppositeOption: IWalletOption,
): 'transferToArgon' | 'transferOutOfArgon' | undefined {
  if (currentOption.type === WalletType.ethereum && isArgonWalletType(oppositeOption.type)) {
    return 'transferToArgon';
  }

  if (oppositeOption.type === WalletType.ethereum && isArgonWalletType(currentOption.type)) {
    return 'transferOutOfArgon';
  }
}

function getExternalNetworkName(currentOption: IWalletOption, oppositeOption: IWalletOption) {
  if (currentOption.type === WalletType.ethereum) {
    return currentOption.name.replace(/ Wallet$/, '');
  }

  if (oppositeOption.type === WalletType.ethereum) {
    return oppositeOption.name.replace(/ Wallet$/, '');
  }

  return '';
}

function getExternalFeeTokenSymbol(currentOption: IWalletOption, oppositeOption: IWalletOption) {
  if (currentOption.type === WalletType.ethereum || oppositeOption.type === WalletType.ethereum) {
    return 'ETH';
  }

  return '';
}

function openTransferOverlay(
  currentOption: IWalletOption,
  oppositeOption: IWalletOption,
  moveToken: IEthereumMoveToken,
  availableAmount: bigint,
) {
  if (currentOption.type === WalletType.ethereum && isArgonWalletType(oppositeOption.type)) {
    activeTransferOverlay.value = {
      direction: 'transferToArgon',
      moveToken,
      availableAmount,
      walletType: oppositeOption.type,
      networkName: currentOption.name.replace(/ Wallet$/, ''),
      feeTokenSymbol: 'ETH',
    };
    return;
  }

  if (oppositeOption.type === WalletType.ethereum && isArgonWalletType(currentOption.type)) {
    activeTransferOverlay.value = {
      direction: 'transferOutOfArgon',
      moveToken,
      availableAmount,
      walletType: currentOption.type,
      networkName: oppositeOption.name.replace(/ Wallet$/, ''),
      feeTokenSymbol: 'ETH',
    };
  }
}

Vue.onMounted(() => {
  draggable.modalPosition.x = props.position.x;
  draggable.modalPosition.y = props.position.y;
  emitPosition();
});

Vue.watch(
  () => props.position,
  position => {
    if (draggable.isDragging) return;
    draggable.modalPosition.x = position.x;
    draggable.modalPosition.y = position.y;
  },
  { deep: true },
);

Vue.watch(() => ({ ...draggable.modalPosition }), emitPosition);

Vue.watch(
  () => props.walletType,
  walletType => {
    firstWalletOption.value = getWalletOption(walletType);
  },
);

Vue.watch(
  () => props.pairedWalletType,
  pairedWalletType => {
    if (pairedWalletType) {
      secondWalletOption.value = getWalletOption(pairedWalletType);
    }
  },
);

function setWalletRef(el: Element | Vue.ComponentPublicInstance | null) {
  walletRef.value = ((el as any)?.$el || el) as HTMLElement | null;
  draggable.setModalRef(el);
}

function startDrag(event: MouseEvent) {
  draggable.onMouseDown(event);

  if (!draggable.isDragging) return;

  window.addEventListener('mousemove', handleWalletDragMove);
  window.addEventListener('mouseup', handleWalletDragEnd, { once: true });
}

function handleWalletDragMove() {
  const payload = getPositionPayload();
  if (!payload) return;
  emit('positionChange', payload);
  emit('dragMove', payload);
}

function handleWalletDragEnd() {
  window.removeEventListener('mousemove', handleWalletDragMove);
  Vue.nextTick(() => {
    const payload = getPositionPayload();
    if (!payload) return;
    emit('positionChange', payload);
    emit('dragEnd', payload);
  });
}

function emitPosition() {
  Vue.nextTick(() => {
    const payload = getPositionPayload();
    if (payload) {
      emit('positionChange', payload);
    }
  });
}

function getPositionPayload() {
  if (!walletRef.value) return;
  return {
    position: { ...draggable.modalPosition },
    rect: walletRef.value.getBoundingClientRect(),
  };
}

Vue.onUnmounted(() => {
  window.removeEventListener('mousemove', handleWalletDragMove);
});
</script>
