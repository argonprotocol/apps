<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="pointer-events-auto relative" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="w-7 h-7 flex flex-row items-center justify-center hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none border rounded-md"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-transparent']"
      >
        <Bars3Icon class="relative w-7 text-slate-800/50" />
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="-5"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
          <div class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem @click="() => openMoveCapitalOverlay()" class="py-2">
              <header>Move Tokens</header>
            </DropdownMenuItem>

            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem @click="() => openWalletOverlay()" class="py-2">
              <header>Receive Tokens</header>
            </DropdownMenuItem>

            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/60" />
            <DropdownMenuItem @click="() => openPortfolioPanel()" class="py-2">
              <header>Asset Breakdown</header>
            </DropdownMenuItem>
          </div>
          <DropdownMenuArrow :width="22" :height="12" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Bars3Icon } from '@heroicons/vue/24/outline';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { PortfolioTab } from '../../panels/interfaces/IPortfolioTab.ts';
import { WalletType } from '../../lib/Wallet.ts';

const props = defineProps<{
  walletType: WalletType.miningHold | WalletType.vaulting;
}>();

const isOpen = Vue.ref(false);

function openWalletOverlay() {
  basicEmitter.emit('openWalletOverlay', { walletType: props.walletType, screen: 'receive' });
}

function openPortfolioPanel() {
  basicEmitter.emit('openPortfolioPanel', PortfolioTab.AssetBreakdown);
}

function openMoveCapitalOverlay() {
  basicEmitter.emit('openMoveCapitalOverlay', { walletType: props.walletType });
}

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

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
  }, 100);
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-4 focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  header {
    @apply text-right whitespace-nowrap text-gray-900;
  }
  p {
    @apply text-right font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}
</style>
