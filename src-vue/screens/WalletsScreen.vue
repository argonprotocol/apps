<template>
  <div class="flex min-h-[calc(100vh-56px)] flex-col" :class="[hasOpenedWallet ? 'opacity-50' : '']">
    <div class="relative px-4 py-3">
      <div class="text-argon-600/60 relative z-20 flex flex-row">
        <div class="w-1/3 grow text-left">
          +{{ numeral(financials.savingsAllTimeReturn).format('0,0.[00]') }}% Buying Power vs
          {{ financials.savingsAllTimeFiatKey }}
        </div>
        <div class="w-1/3 grow text-center">Argon Is 0.002 UNDER $1.06 Target</div>
        <div class="w-1/3 grow text-right">
          {{ numeral(financials.savingsRestabilizationPower).formatIfElse('< 10', '0,0.[0]', '0,0') }}:1 Restabilization
          Power
        </div>
      </div>
      <div
        class="via-argon-100/30 absolute top-0 left-0 h-full w-full bg-gradient-to-r from-transparent to-transparent"
      />
      <div
        class="via-argon-300/30 absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"
      />
    </div>
    <div class="flex grow flex-col items-center justify-center">
      <div class="text-argon-600 text-8xl font-bold">₳45,384.00</div>
      <p
        class="mt-5 text-center text-lg leading-normal font-light text-slate-800/60"
        style="text-shadow: 1px 1px 0 white"
      >
        Click any wallet below to open it. Drag any two open wallets
        <br />
        together to create a jump portal between them.
      </p>

      <ul
        ref="walletListRef"
        class="border-argon-600/20 relative mt-10 flex w-8/12 flex-row flex-wrap gap-3 border-y py-3"
      >
        <div
          v-if="dropIndicatorStyle"
          class="bg-argon-500 pointer-events-none fixed z-50 w-1 rounded-full shadow-[0_0_14px_rgba(183,76,186,0.55)]"
          :style="dropIndicatorStyle"
        />
        <div
          v-if="dragPreviewWallet && dragPreviewStyle"
          class="border-argon-600/20 pointer-events-none fixed z-50 flex h-[75px] flex-row rounded-lg border bg-[var(--bg-color)] px-4 py-3 opacity-95 shadow-xl"
          :style="dragPreviewStyle"
        >
          <div class="flex w-10 flex-col items-center justify-center">
            <component :is="dragPreviewWallet.logo" :class="dragPreviewWallet.logoClass" />
          </div>
          <div class="ml-3 flex w-full flex-col">
            <header class="relative flex w-full flex-row font-bold">
              <div class="grow">{{ dragPreviewWallet.name }}</div>
              <div class="flex flex-col justify-center gap-y-1 px-1 text-slate-400">
                <span class="h-1 w-1 rounded-full bg-current" />
                <span class="h-1 w-1 rounded-full bg-current" />
                <span class="h-1 w-1 rounded-full bg-current" />
              </div>
            </header>
            <div>{{ dragPreviewWallet.summary }}</div>
          </div>
        </div>
        <li
          v-for="wallet in walletRecords"
          :key="wallet.type"
          data-wallet-record
          :data-wallet-type="wallet.type"
          @click="openWallet(wallet.type)"
          @pointerdown="startWalletRecordPointer($event, wallet)"
          :class="[draggedWalletType === wallet.type ? 'opacity-30' : '']"
          class="border-argon-600/20 flex h-[75px] w-1/3 cursor-grab touch-none flex-row rounded-lg border bg-[var(--bg-color)] px-4 py-3 hover:bg-white/50 active:cursor-grabbing"
        >
          <div class="flex w-10 flex-col items-center justify-center">
            <component :is="wallet.logo" :class="wallet.logoClass" />
          </div>
          <div class="ml-3 flex w-full flex-col">
            <header class="relative flex w-full flex-row font-bold">
              <div class="grow">{{ wallet.name }}</div>
              <Menu @click.stop @pointerdown.stop />
            </header>
            <div>{{ wallet.summary }}</div>
          </div>
        </li>
        <li
          data-wallet-add
          class="border-argon-600/20 relative flex h-[75px] w-16 cursor-pointer flex-row rounded-lg border px-4 py-3 hover:bg-white/50"
        >
          <div class="absolute top-1/2 left-1/2 -translate-1/2 text-4xl leading-0 font-bold">+</div>
        </li>
      </ul>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/wallets.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { WalletType } from '../lib/Wallet.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import EthereumLogo from '../assets/wallets/networks/ethereum.svg?component';
import ArgonLogo from '../assets/wallets/networks/argon.svg?component';
import { openWalletOverlayCount } from '../wallets/WalletDialogs.vue';
import { useFinancials } from '../stores/financials.ts';
import numeral from '../lib/numeral.ts';
import Menu from '../wallets/components/Menu.vue';

const financials = useFinancials();

const walletListRef = Vue.ref<HTMLUListElement | null>(null);
const walletRecords = Vue.ref([
  {
    type: WalletType.ethereum,
    name: 'Ethereum Wallet',
    summary: '0 tokens, $0.00',
    logo: Vue.markRaw(EthereumLogo),
    logoClass: 'h-10/12',
  },
  {
    type: WalletType.vaulting,
    name: 'Argon Wallet',
    summary: '0 tokens, $0.00',
    logo: Vue.markRaw(ArgonLogo),
    logoClass: 'h-9/12',
  },
]);
type IWalletRecord = (typeof walletRecords.value)[number];

const hasOpenedWallet = Vue.computed(() => openWalletOverlayCount.value > 0);
const draggedWalletType = Vue.ref<WalletType | undefined>();
const pendingDrag = Vue.ref<{
  wallet: IWalletRecord;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
}>();
const dragPreviewRect = Vue.ref<{ top: number; left: number; width: number }>();
const dropIndex = Vue.ref<number | undefined>();
const dropIndicatorRect = Vue.ref<{ top: number; left: number; height: number }>();
const dragPreviewWallet = Vue.computed(() =>
  draggedWalletType.value ? walletRecords.value.find(wallet => wallet.type === draggedWalletType.value) : undefined,
);
const dragPreviewStyle = Vue.computed(() => {
  if (!dragPreviewRect.value) return;
  return {
    top: `${dragPreviewRect.value.top}px`,
    left: `${dragPreviewRect.value.left}px`,
    width: `${dragPreviewRect.value.width}px`,
  };
});
const dropIndicatorStyle = Vue.computed(() => {
  if (!dropIndicatorRect.value) return;
  return {
    top: `${dropIndicatorRect.value.top}px`,
    left: `${dropIndicatorRect.value.left}px`,
    height: `${dropIndicatorRect.value.height}px`,
  };
});
let suppressNextClick = false;

function openWallet(walletType: WalletType) {
  if (suppressNextClick) return;
  basicEmitter.emit('openWalletOverlay', { walletType: walletType as any });
}

function startWalletRecordPointer(event: PointerEvent, wallet: IWalletRecord) {
  if (event.button !== 0) return;

  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  pendingDrag.value = {
    wallet,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
  };

  window.addEventListener('pointermove', handleWalletPointerMove);
  window.addEventListener('pointerup', handleWalletPointerUp, { once: true });
}

function handleWalletPointerMove(event: PointerEvent) {
  if (!pendingDrag.value || event.pointerId !== pendingDrag.value.pointerId) return;

  const dx = event.clientX - pendingDrag.value.startX;
  const dy = event.clientY - pendingDrag.value.startY;
  const hasStartedDrag = !!draggedWalletType.value;
  if (!hasStartedDrag && Math.hypot(dx, dy) < 4) return;

  if (!hasStartedDrag) {
    draggedWalletType.value = pendingDrag.value.wallet.type;
    document.body.classList.add('cursor-grabbing');
  }

  dragPreviewRect.value = {
    top: event.clientY - pendingDrag.value.offsetY,
    left: event.clientX - pendingDrag.value.offsetX,
    width: pendingDrag.value.width,
  };
  updateDropIndicator(event.clientX);
  event.preventDefault();
}

function handleWalletPointerUp(event: PointerEvent) {
  if (pendingDrag.value && event.pointerId !== pendingDrag.value.pointerId) return;

  const didDrag = !!draggedWalletType.value;
  if (didDrag) {
    reorderDraggedWallet();
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    });
  }
  clearDragState();
}

function updateDropIndicator(clientX: number) {
  if (!walletListRef.value || !draggedWalletType.value) return;

  const walletElements = Array.from(walletListRef.value.querySelectorAll<HTMLElement>('[data-wallet-record]')).filter(
    element => element.dataset.walletType !== draggedWalletType.value,
  );
  if (!walletElements.length) {
    dropIndex.value = 0;
    dropIndicatorRect.value = undefined;
    return;
  }

  let nextIndex = walletElements.length;
  let targetElement = walletElements[walletElements.length - 1];
  let useLeftEdge = false;

  for (const [index, element] of walletElements.entries()) {
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      nextIndex = index;
      targetElement = element;
      useLeftEdge = true;
      break;
    }
  }

  const targetRect = targetElement.getBoundingClientRect();
  const listRect = walletListRef.value.getBoundingClientRect();
  const addTile = walletListRef.value.querySelector<HTMLElement>('[data-wallet-add]');
  const addTileRect = addTile?.getBoundingClientRect();
  const indicatorWidth = 4;
  const endDropLeft = addTileRect
    ? targetRect.right + (addTileRect.left - targetRect.right) / 2 - indicatorWidth / 2
    : targetRect.right + 8;
  dropIndex.value = nextIndex;
  dropIndicatorRect.value = {
    top: targetRect.top,
    left: useLeftEdge ? targetRect.left - 8 : endDropLeft,
    height: Math.min(targetRect.height, listRect.height),
  };
}

function clearDragState() {
  draggedWalletType.value = undefined;
  pendingDrag.value = undefined;
  dragPreviewRect.value = undefined;
  dropIndex.value = undefined;
  dropIndicatorRect.value = undefined;
  document.body.classList.remove('cursor-grabbing');
  window.removeEventListener('pointermove', handleWalletPointerMove);
}

function reorderDraggedWallet() {
  const walletType = draggedWalletType.value;
  const targetIndex = dropIndex.value;
  if (!walletType || targetIndex === undefined) return;

  const oldIndex = walletRecords.value.findIndex(wallet => wallet.type === walletType);
  if (oldIndex === -1) return;

  const [movedWallet] = walletRecords.value.splice(oldIndex, 1);
  if (!movedWallet) return;
  walletRecords.value.splice(Math.min(targetIndex, walletRecords.value.length), 0, movedWallet);
}

Vue.onUnmounted(() => {
  clearDragState();
});
</script>
