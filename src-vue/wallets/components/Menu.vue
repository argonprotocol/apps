<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="pointer-events-auto relative flex flex-row items-center" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="group relative flex h-[22px] w-[22px] cursor-pointer flex-col items-center justify-center gap-y-1 rounded text-slate-400 hover:bg-slate-400/10 hover:text-slate-500 focus:outline-none data-[state=open]:bg-slate-400/10 data-[state=open]:text-slate-500"
      >
        <span class="h-1 w-1 rounded-full bg-current" />
        <span class="h-1 w-1 rounded-full bg-current" />
        <span class="h-1 w-1 rounded-full bg-current" />
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="-5"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-[1000] data-[state=open]:transition-all"
        >
          <div class="bg-argon-menu-bg flex min-w-66 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem MenuItem @click="() => openAboutOverlay()">
              <header>Open Wallet Overlay</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger :class="submenuTriggerClass">
                <ChevronLeftIcon class="absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 text-gray-400" />
                <header>Create a Transfer Portal</header>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent
                  :side="'left'"
                  :sideOffset="4"
                  class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-[1001] data-[state=open]:transition-all"
                >
                  <div class="min-w-50 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                    <DropdownMenuItem MenuItem @click="openWallet(WalletType.miningHold)">
                      <header>Argon to Ethereum</header>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                    <DropdownMenuItem MenuItem @click="openWallet(WalletType.vaulting)">
                      <header>Ethereum to Argon</header>
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openProfileOverlay()" >
              <header>Open Ethereum QR Code</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openProfileOverlay()" >
              <header>Copy Ethereum Address</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openProfileOverlay()" >
              <header>View Recovery Phrase</header>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openProfileOverlay()" >
              <header>Disconnect Wallet from App</header>
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
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from 'reka-ui';
import type { PointerDownOutsideEvent } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import { WalletType } from '../../lib/Wallet.ts';

const rootRef = Vue.ref<HTMLElement>();
const isOpen = Vue.ref(false);

const submenuTriggerClass =
  'relative block w-full cursor-pointer rounded px-4 py-2 pl-10 text-right hover:bg-argon-menu-hover focus:bg-argon-menu-hover focus:outline-none data-[state=open]:bg-argon-menu-hover';

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function openWallet(walletType: WalletType) {
  basicEmitter.emit('openWalletOverlay', { walletType: walletType as any });
}

function openAboutOverlay() {
  basicEmitter.emit('openAboutOverlay');
}

function openProfileOverlay(): void {
  basicEmitter.emit('openProfileOverlay');
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
  @apply cursor-pointer focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  header {
    @apply text-right font-bold whitespace-nowrap text-gray-900;
  }
  p {
    @apply text-right font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}

[MenuItem] {
  @apply hover:bg-argon-menu-hover focus:bg-argon-menu-hover block cursor-pointer rounded px-4 py-2 text-right focus:outline-none;
}
</style>
