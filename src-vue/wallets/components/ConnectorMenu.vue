<!-- prettier-ignore -->
<template>
  <DropdownMenuRoot v-model:open="isOpen">
    <DropdownMenuTrigger
      Trigger
      asChild
    >
      <slot :isOpen="isOpen" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :data-wallet-connector-id="props.connectorId"
        :align="'end'"
        :alignOffset="-5"
        :sideOffset="-3"
        :style="floatingZIndex"
        class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade data-[state=open]:transition-all"
      >
        <div class="bg-argon-menu-bg flex min-w-66 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <template v-if="walletType === WalletType.ethereum">
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <CopyToClipboard
                :content="props.wallet?.address ?? ''"
              >
                <div ItemWrapper>
                  <header>Copy Ethereum Address</header>
                  <CopyIcon class="w-3.5" />
                </div>
                <template #copying>
                  <CopyIcon class="w-3.5" />
                </template>
              </CopyToClipboard>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
          </template>
          <template v-if="walletType === WalletType.bitcoin">
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <div ItemWrapper>
                <header>Create New Channel</header>
                <ShieldCheckIcon class="w-4 h-4" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
          </template>
          <template v-else>
            <DropdownMenuItem MenuItem @click="updateTokens">
              <div ItemWrapper>
                <header>Refresh Token Data</header>
                <ArrowPathIcon class="h-4 w-4" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <DropdownMenuItem MenuItem @click="() => openRecovery()" >
              <div ItemWrapper>
                <header>Open Transfer Window</header>
                <ShieldCheckIcon class="w-4 h-4" />
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
          </template>
          <DropdownMenuItem MenuItem @click="disconnectWallet" :class="walletType === WalletType.bitcoin ? 'opacity-30 pointer-events-none' : ''">
            <div ItemWrapper>
              <header>Disconnect from App</header>
              <LinkSlashIcon class="h-4 w-4" />
            </div>
          </DropdownMenuItem>
        </div>
        <DropdownMenuArrow :width="22" :height="12" class="mt-[0px] fill-white stroke-gray-300" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
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
import type { WalletForBitcoin } from '../../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { ArrowPathIcon, KeyIcon, LinkSlashIcon, WindowIcon, ShieldCheckIcon } from '@heroicons/vue/24/outline';
import QRCode from 'qrcode';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CopyIcon from '../../assets/copy.svg';
import MoreIcon from '../../assets/more.svg';
import BitcoinIcon from '../../assets/wallets/networks/bitcoin.svg';
import SendIcon from '../../assets/send.svg';

const props = withDefaults(
  defineProps<{
    connectorId?: string;
    direction: 'right' | 'left';
    wallet?: WalletForBitcoin | WalletForEthereum;
  }>(),
  {},
);

const rootRef = Vue.ref<HTMLElement>();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex(2);
const showQrCode = Vue.ref(false);
const qrCode = Vue.ref('');
const walletType = Vue.computed(() => props.wallet?.type);

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function toggleQRCode(event: Event) {
  event.preventDefault();
  showQrCode.value = !showQrCode.value;
}

async function loadQRCode() {
  // const address = props.wallet?.address;
  // qrCode.value = await QRCode.toDataURL(address, {
  //   margin: 0,
  //   color: {
  //     dark: '#0f172a',
  //     light: '#0000',
  //   },
  // });
}

function disconnectWallet() {
  if (props.wallet?.type !== WalletType.ethereum) return;
  isOpen.value = false;
  basicEmitter.emit('openWalletDisconnectOverlay', { wallet: props.wallet });
}

function openRecovery() {
  basicEmitter.emit('openSecuritySettingsOverlay', { screen: 'mnemonics' });
}

function updateTokens() {
  if (props.wallet?.type !== WalletType.ethereum) return;
  isOpen.value = false;
  void props.wallet.refresh();
}

Vue.watch(isOpen, open => {
  if (open) return;
});

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
