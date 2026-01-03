<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="pointer-events-auto relative" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="w-7 h-7 flex flex-row items-center justify-center hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none border rounded-md"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-transparent']"
      >
        <GlobeIcon class="h-4 w-4 text-slate-800/50" />
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="0"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
          <div class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem class="pt-1 pb-2">
              <CopyToClipboard :content="wallet.address" class="group relative cursor-pointer">
                <div class="flex flex-col">
                  <div class="flex flex-row items-center justify-end">
                    <div class="text-slate-700 group-hover:text-argon-600">Copy Address</div>
                    <CopyIcon class="ml-1 inline-block h-4 w-4 text-slate-600/80 group-hover:text-slate-600" />
                  </div>
                  <div class="text-slate-600/60">
                    {{ abbreviateAddress(wallet.address, 10) }}
                  </div>
                </div>
                <template #copied>
                  <div class="pointer-events-none absolute top-0 left-0 h-full w-full flex flex-col">
                    <div class="flex flex-row items-center justify-end">
                      Copy Address
                      <CopyIcon class="ml-1 inline-block h-4 w-4 " />
                    </div>
                    <div>
                      {{ abbreviateAddress(wallet.address, 10) }}
                    </div>
                  </div>
                </template>
              </CopyToClipboard>
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
import GlobeIcon from '../../assets/globe.svg?component';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CopyIcon from '../../assets/copy.svg';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { IWallet, WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';

const props = defineProps<{
  walletType: WalletType.mining | WalletType.vaulting;
}>();

const wallets = useWallets();

const isOpen = Vue.ref(false);

const wallet = Vue.computed<IWallet>(() => {
  if (props.walletType === WalletType.mining) {
    return wallets.miningWallet;
  } else if (props.walletType === WalletType.vaulting) {
    return wallets.vaultingWallet;
  }
  throw new Error(`Unknown wallet type: ${props.walletType}`);
});

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
