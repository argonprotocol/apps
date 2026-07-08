<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="pointer-events-auto relative flex flex-row items-center" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="group relative flex  cursor-pointer flex-col items-center justify-center gap-y-[2px] rounded-md text-slate-400 hover:bg-slate-400/10 hover:text-slate-500 focus:outline-none data-[state=open]:bg-slate-400/10 data-[state=open]:text-slate-500"
        :class="[showBorders ? 'h-[34px] w-[34px] border border-slate-400/60' : 'h-[22px] w-[22px]']"
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
          :style="floatingZIndex"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade data-[state=open]:transition-all"
        >
          <div class="bg-argon-menu-bg flex min-w-66 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <template v-if="!props.walletIsOpen">
              <DropdownMenuItem MenuItem @click="() => openWallet(walletType)">
                <div ItemWrapper>
                  <header>Open Wallet Overlay</header>
                  <WindowIcon class="w-4 h-4" />
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            </template>
            <DropdownMenuItem MenuItem @click="() => copyEthereumAddress()" >
              <CopyToClipboard
                :content="wallet.address"
              >
                <div ItemWrapper>
                  <header>Copy Wallet Address</header>
                  <CopyIcon class="w-4 h-4" />
                </div>
                <template #copying>
                  <div ItemWrapper class="absolute top-0 left-0 w-full h-full">
                    <header>Copy Wallet Address</header>
                    <CopyIcon class="w-4 h-4" />
                  </div>
                </template>
              </CopyToClipboard>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @select="toggleQRCode" >
              <div ItemWrapper>
                <header>View Wallet QR Code</header>
                <QrCodeIcon class="w-4 h-4" />
              </div>
              <img v-if="showQrCode" :src="qrCode" class="w-40 max-w-full mt-4" :alt="`QR Code Wallet Address`" />
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <div ItemWrapper>
                <header>View Recovery Phrase</header>
                <ShieldCheckIcon class="w-4 h-4" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => disconnectWallet()" >
              <div ItemWrapper>
                <header>Disconnect Wallet from App</header>
              </div>
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
  DropdownMenuTrigger,
} from 'reka-ui';
import type { PointerDownOutsideEvent } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { WindowIcon, QrCodeIcon, ShieldCheckIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../../assets/copy.svg';
import QRCode from 'qrcode';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const props = withDefaults(
  defineProps<{
    wallet: { address: string };
    walletType: WalletType;
    walletIsOpen?: boolean;
    showBorders?: boolean;
  }>(),
  {
    walletIsOpen: false,
    showBorders: true,
  },
);

const rootRef = Vue.ref<HTMLElement>();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex();

const showQrCode = Vue.ref(false);
const qrCode = Vue.ref('');

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function toggleQRCode(event: Event) {
  event.preventDefault();
  showQrCode.value = !showQrCode.value;
}

async function loadQRCode() {
  let address = props.wallet.address;
  qrCode.value = await QRCode.toDataURL(address, {
    margin: 0,
    color: {
      dark: '#0f172a',
      light: '#0000',
    },
  });
}

function disconnectWallet() {}

function openRecovery() {
  basicEmitter.emit('openSecuritySettingsOverlay', { screen: 'mnemonics' });
}

function openWallet(walletType: WalletType) {
  basicEmitter.emit('openWalletOverlay', { walletType: walletType as any });
}

function copyEthereumAddress() {}

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

Vue.onMounted(() => {
  void loadQRCode();
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
