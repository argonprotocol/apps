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
            <DropdownMenuItem MenuItem @select="toggleQRCode" class="pl-0!">
              <div v-if="!showQrCode" ItemWrapper>
                <header>Send Tokens</header>
                <SendIcon class="w-4 h-4" />
              </div>
              <img v-if="showQrCode" :src="qrCode" class="w-40 max-w-full mt-1.5" :alt="`QR Code Wallet Address`" />
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @select="toggleQRCode" class="pl-0!">
              <div v-if="!showQrCode" ItemWrapper>
                <header>Receive Tokens</header>
                <SendIcon class="w-4 h-4 scale-x-[-1]" />
              </div>
              <img v-if="showQrCode" :src="qrCode" class="w-40 max-w-full mt-1.5" :alt="`QR Code Wallet Address`" />
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <CopyToClipboard
                :content="props.wallet.address"
              >
                <div ItemWrapper>
                  <header>{{ isEthereumWalletSelection(props.selection) ? 'Copy Ethereum Address' : 'Copy Argon Address' }}</header>
                  <CopyIcon class="w-3.5" />
                </div>
                <template #copying>
                  <CopyIcon class="w-3.5" />
                </template>
              </CopyToClipboard>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <div ItemWrapper>
                <header>View Private Key</header>
                <ShieldCheckIcon class="w-4 h-4" />
              </div>
            </DropdownMenuItem>
            <template v-if="props.canExportPrivateKey">
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
              <DropdownMenuItem MenuItem @click="openEthereumPrivateKeyExport">
                <div ItemWrapper>
                  <header>Export Private Key</header>
                  <KeyIcon class="w-4 h-4" />
                </div>
              </DropdownMenuItem>
            </template>
            <template v-if="isEthereumWalletSelection(props.selection)">
              <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
              <DropdownMenuItem MenuItem @click="disconnectWallet">
                <div ItemWrapper>
                  <header>Disconnect Wallet from App</header>
                  <LinkSlashIcon class="h-4 w-4" />
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
import { WalletType } from '../../lib/Wallet.ts';
import { KeyIcon, LinkSlashIcon, WindowIcon, ShieldCheckIcon } from '@heroicons/vue/24/outline';
import QRCode from 'qrcode';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { isEthereumWalletSelection, type IWalletSelection } from '../walletOverlayState.ts';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CopyIcon from '../../assets/copy.svg';
import MoreIcon from '../../assets/more.svg';
import SendIcon from '../../assets/send.svg';

const props = withDefaults(
  defineProps<{
    selection: IWalletSelection;
    wallet: { address: string };
    walletIsOpen?: boolean;
    canExportPrivateKey?: boolean;
    testIdPrefix?: string;
    showBorders?: boolean;
  }>(),
  {
    walletIsOpen: false,
    canExportPrivateKey: false,
    showBorders: true,
  },
);

const rootRef = Vue.ref<HTMLElement>();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex(2);
const showQrCode = Vue.ref(false);
const qrCode = Vue.ref('');
type PortalSubmenu = 'outgoing' | 'incoming';
const activePortalSubmenu = Vue.ref<PortalSubmenu>();
const hoveredPortalSubmenu = Vue.ref<PortalSubmenu>();
let portalSubmenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined;

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

function disconnectWallet() {
  if (!isEthereumWalletSelection(props.selection)) return;
  isOpen.value = false;
  basicEmitter.emit('openWalletDisconnectOverlay', { walletRecordId: props.selection.walletRecord.id });
}

function openRecovery() {
  basicEmitter.emit('openSecuritySettingsOverlay', { screen: 'mnemonics' });
}

function openEthereumPrivateKeyExport() {
  basicEmitter.emit('openSecuritySettingsOverlay', { screen: 'ethereum-export' });
}

function openWallet() {
  if (isEthereumWalletSelection(props.selection)) {
    basicEmitter.emit('openWalletOverlay', {
      connectorType: WalletType.ethereum,
      ethereumWalletRecordId: props.selection.walletRecord.id,
    });
    return;
  }

  basicEmitter.emit('openWalletOverlay', { connectorType: WalletType.defaultArgon });
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

Vue.watch(isOpen, open => {
  if (open) return;
  if (portalSubmenuCloseTimeoutId) clearTimeout(portalSubmenuCloseTimeoutId);
  portalSubmenuCloseTimeoutId = undefined;
  activePortalSubmenu.value = undefined;
  hoveredPortalSubmenu.value = undefined;
});

Vue.onMounted(() => {
  void loadQRCode();
});

Vue.onBeforeUnmount(() => {
  if (mouseLeaveTimeoutId) clearTimeout(mouseLeaveTimeoutId);
  if (portalSubmenuCloseTimeoutId) clearTimeout(portalSubmenuCloseTimeoutId);
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
