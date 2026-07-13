<!-- prettier-ignore -->
<template>
  <div @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" :modal="false" v-model:open="isOpen">
      <div class="h-px bg-slate-500/20" />
      <DropdownMenuTrigger asChild>
        <div
          class="flex w-full flex-row items-center px-3 py-2 my-1 text-left text-slate-900/60 hover:text-slate-900 hover:bg-argon-100/30  focus:outline-none"
        >
          <span class="grow">External Wallets</span>
          <ChevronRightIcon class="h-4" />
        </div>
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          :align="'end'"
          :side="'right'"
          :sideOffset="6"
          :style="floatingZIndex"
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          class="relative data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade data-[state=open]:transition-all"
        >
          <div class="absolute top-0 -left-3 h-full w-3" />
          <div class="bg-argon-menu-bg flex min-w-64 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem
              v-for="wallet in ethereumWallets"
              :key="wallet.id"
              class="py-2"
              @select.prevent="openWallet(wallet)"
            >
              <div class="flex flex-col">
                <header>{{ wallet.name }}</header>
                <p>{{ abbreviateAddress(wallet.address, 8) }}</p>
              </div>
            </DropdownMenuItem>

            <DropdownMenuItem v-if="ethereumWallets.length === 0" disabled class="py-2">
              <div class="flex flex-col">
                <header>No wallets yet</header>
                <p>Add an external wallet to get started.</p>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />

            <DropdownMenuItem class="py-2" @select.prevent="addWallet">
              <div class="flex flex-row items-center gap-x-2">
                <PlusIcon class="h-4 w-4 text-argon-600" />
                <header>Add Wallet</header>
              </div>
            </DropdownMenuItem>
          </div>
          <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronRightIcon, PlusIcon } from '@heroicons/vue/24/outline';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { useWallets } from '../stores/wallets.ts';
import { WalletType } from '../lib/Wallet.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { useFloatingZIndex } from '../overlays/helpers/OverlayZIndex.ts';

const wallets = useWallets();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex();
let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

const ethereumWallets = Vue.computed(() => wallets.walletRecords.filter(wallet => wallet.walletType === 'ethereum'));

async function openWallet(wallet: IWalletRecord) {
  await wallets.selectEthereumWalletRecord(wallet.id);
  closeMenu();
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.ethereum });
}

function addWallet() {
  closeMenu();
  basicEmitter.emit('openEthereumWalletImportOverlay', 'choice');
}

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  isOpen.value = true;
}

function onMouseLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
    mouseLeaveTimeoutId = undefined;
  }, 250);
}

function closeMenu() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  isOpen.value = false;
}

Vue.onBeforeUnmount(() => {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
});
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-4 focus:outline-none;

  &[data-disabled] {
    opacity: 0.55;
    pointer-events: none;
  }
  header {
    @apply whitespace-nowrap text-gray-900;
  }
  p {
    @apply font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}
</style>
