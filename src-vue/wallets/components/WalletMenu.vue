<!-- prettier-ignore -->
<template>
  <div ref="rootRef" data-wallet-menu-surface class="pointer-events-auto relative flex flex-row items-center" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        :data-testid="props.testIdPrefix ? `${props.testIdPrefix}.openMenu()` : undefined"
        class="focus:outline-none cursor-pointer"
      >
        <span
          class="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border text-slate-500/60 hover:bg-[#f1f3f7]"
          :class="
            props.showBorders
              ? 'border-slate-400/60 hover:border-slate-500/60'
              : 'border-transparent hover:border-slate-500/30'
          "
        >
          <MoreIcon class="h-4" />
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          data-wallet-menu-surface
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="-5"
          :sideOffset="-3"
          :style="floatingZIndex"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade data-[state=open]:transition-all"
        >
          <div class="bg-argon-menu-bg flex min-w-66 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <template v-if="!props.walletIsOpen">
              <DropdownMenuItem MenuItem @click="openWallet">
                <div ItemWrapper>
                  <header>Open Wallet Overlay</header>
                  <WindowIcon class="w-4 h-4" />
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            </template>
            <DropdownMenuItem MenuItem @select="sendTokens" class="pl-0!">
              <div ItemWrapper>
                <header>Send Tokens</header>
                <SendIcon class="h-5" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @select="receiveTokens" class="pl-0!">
              <div ItemWrapper>
                <header>Receive Tokens</header>
                <ReceiveIcon class="h-5" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem>
              <CopyToClipboard :content="props.wallet.address">
                <div ItemWrapper>
                  <header>Copy Argon Address</header>
                  <CopyIcon class="w-3.5" />
                </div>
                <template #copying>
                  <div class="flex flex-row items-center gap-x-2" ItemWrapper>
                    <header>Copy Argon Address</header>
                    <CopyIcon class="w-3.5" />
                  </div>
                </template>
              </CopyToClipboard>
            </DropdownMenuItem>
            <template v-if="props.wallet.type === WalletType.argon">
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
              <DropdownMenuItem MenuItem @click="viewPrivateKey">
                <div ItemWrapper>
                  <header>Private Key</header>
                  <ShieldCheckIcon class="w-4 h-4" />
                </div>
              </DropdownMenuItem>
            </template>
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
  DropdownMenuTrigger,
} from 'reka-ui';
import type { PointerDownOutsideEvent } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';
import { ShieldCheckIcon, WindowIcon } from '@heroicons/vue/24/outline';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { useWallets } from '../../stores/wallets.ts';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CopyIcon from '../../assets/copy.svg';
import MoreIcon from '../../assets/more.svg';
import SendIcon from '../../assets/wallets/send.svg';
import ReceiveIcon from '../../assets/wallets/receive.svg';
import type { IWalletView } from '../walletOverlayState.ts';

const props = withDefaults(
  defineProps<{
    wallet: IWallet;
    walletIsOpen?: boolean;
    testIdPrefix?: string;
    showBorders?: boolean;
  }>(),
  {
    walletIsOpen: false,
    showBorders: true,
  },
);

const rootRef = Vue.ref<HTMLElement>();
const wallets = useWallets();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex(2);

const isEthereumWallet = Vue.computed(() => props.wallet.type === WalletType.ethereum);
const ethereumWalletRecord = Vue.computed(() => {
  if (!isEthereumWallet.value) return;
  return wallets.walletRecords.find(
    record => record.walletType === 'ethereum' && record.address.toLowerCase() === props.wallet.address.toLowerCase(),
  );
});

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function viewPrivateKey() {
  openWalletView('privateKey');
}

function openWallet() {
  openWalletView('main');
}

function receiveTokens() {
  openWalletView('receive');
}

function sendTokens() {
  openWalletView('send');
}

function openWalletView(view: IWalletView) {
  isOpen.value = false;
  if (ethereumWalletRecord.value) {
    basicEmitter.emit('openWalletOverlay', {
      connectorType: WalletType.ethereum,
      ethereumWalletRecordId: ethereumWalletRecord.value.id,
      view,
    });
    return;
  }

  basicEmitter.emit('openWalletOverlay', { connectorType: WalletType.argon, view });
}

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  isOpen.value = true;
}

function onMouseLeave(event: MouseEvent) {
  if ((event.relatedTarget as HTMLElement | null)?.closest('[data-wallet-menu-surface]')) return;

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

Vue.onBeforeUnmount(() => {
  if (mouseLeaveTimeoutId) clearTimeout(mouseLeaveTimeoutId);
});
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
    @apply grow text-right font-bold whitespace-nowrap text-gray-900;
  }
  p {
    @apply text-right font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}

[MenuItem] {
  @apply hover:bg-argon-menu-hover focus:bg-argon-menu-hover flex cursor-pointer flex-col items-end rounded py-2 pr-2 pl-4 text-right focus:outline-none;
}
[ItemWrapper] {
  @apply flex flex-row items-center gap-x-2;
}
</style>
