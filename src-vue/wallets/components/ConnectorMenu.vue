<template>
  <DropdownMenuRoot v-model:open="isOpen">
    <DropdownMenuTrigger asChild><slot :isOpen="isOpen" /></DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        :data-wallet-connector-id="props.connectorId"
        align="end"
        :alignOffset="-5"
        :sideOffset="-3"
        :collisionPadding="30"
        :style="floatingZIndex"
        class="bg-argon-menu-bg flex min-w-66 flex-col rounded p-1 text-sm/6 text-gray-900 shadow-lg ring-1 ring-gray-900/20"
        @closeAutoFocus.prevent
      >
        <DropdownMenuItem @select="void props.wallet.refresh()">
          <span>Refresh Tokens</span>
          <ArrowPathIcon class="size-4" />
        </DropdownMenuItem>
        <DropdownMenuItem @select="openRename">
          <span>Rename</span>
          <PencilSquareIcon class="size-4" />
        </DropdownMenuItem>
        <DropdownMenuItem @select="basicEmitter.emit('openWalletDisconnectOverlay', { wallet: props.wallet })">
          <span>Remove</span>
          <LinkSlashIcon class="size-4" />
        </DropdownMenuItem>
        <DropdownMenuItem v-if="props.wallet.isCore && props.wallet.isPersisted" @select="exportIsOpen = true">
          <span>Export Private Key</span>
          <KeyIcon class="size-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-slate-400/30" />
        <WalletGuideAnchor
          autoOpenGuidance
          :open="isOpen && !!props.showGuidance"
          :side="props.direction === 'left' ? 'right' : 'left'"
          guidancePosition="top"
          guidance="Buy ARGN on Uniswap so your transfer counts toward certification. Close this menu when you're ready to transfer ARGN into the app."
          @close="isOpen = false"
        >
          <DropdownMenuItem asChild :disabled="!chainConfig">
            <a
              :href="chainConfig && StableSwaps.getUniswapMarketUrl(chainConfig.argonTokenAddress, chainConfig.chainId)"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>Uniswap Market for ARGN</span>
              <ArrowTopRightOnSquareIcon class="size-4" />
            </a>
          </DropdownMenuItem>
        </WalletGuideAnchor>
        <DropdownMenuItem asChild :disabled="!chainConfig">
          <a
            :href="chainConfig && StableSwaps.getUniswapMarketUrl(chainConfig.argonotTokenAddress, chainConfig.chainId)"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>Uniswap Market for ARGNOT</span>
            <ArrowTopRightOnSquareIcon class="size-4" />
          </a>
        </DropdownMenuItem>
        <DropdownMenuArrow :width="22" :height="12" class="fill-argon-menu-bg stroke-gray-300" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>

  <OverlayBase
    title="Rename Ethereum Wallet"
    :isOpen="renameIsOpen"
    :disallowClose="isRenaming"
    class="w-xl"
    @close="renameIsOpen = false"
  >
    <form class="px-6 py-5 text-gray-700" @submit.prevent="renameWallet">
      <label for="ethereum-wallet-name" class="mb-1 block font-bold text-gray-500/80">Wallet Name</label>
      <input
        id="ethereum-wallet-name"
        v-model="walletName"
        type="text"
        autocomplete="off"
        maxlength="18"
        :disabled="isRenaming"
        class="w-full rounded-md border border-slate-700/50 bg-white px-3 py-2"
      />
      <p v-if="renameError" role="alert" class="mt-4 text-sm text-red-700">{{ renameError }}</p>
      <div class="mt-6 flex justify-end gap-3 border-t border-slate-300 pt-4">
        <button
          type="button"
          :disabled="isRenaming"
          class="border-argon-button text-argon-button hover:border-argon-button-hover hover:text-argon-button-hover rounded border bg-white px-5 py-2 disabled:opacity-50"
          @click="renameIsOpen = false"
        >
          Cancel
        </button>
        <button
          type="submit"
          :disabled="isRenaming || !walletName.trim()"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover rounded border px-5 py-2 font-bold text-white disabled:cursor-default disabled:opacity-50"
        >
          {{ isRenaming ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </form>
  </OverlayBase>

  <OverlayBase
    title="Export Default Ethereum Private Key"
    :isOpen="exportIsOpen"
    class="w-160"
    @close="exportIsOpen = false"
  >
    <WalletViewPrivateKey
      v-if="exportIsOpen && props.wallet.isCore && props.wallet.isPersisted"
      :walletType="WalletType.ethereum"
      :showHeader="false"
      :isDragging="false"
      :showBack="false"
    />
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { raceWithTimeout } from '@argonprotocol/apps-core';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  KeyIcon,
  LinkSlashIcon,
  PencilSquareIcon,
} from '@heroicons/vue/24/outline';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { loadEthereumChainConfig, type IEthereumChainConfig } from '../../lib/EthereumClient.ts';
import { StableSwaps } from '../../lib/StableSwaps.ts';
import type { WalletForEthereum } from '../../lib/WalletForEthereum.ts';
import { WalletType } from '../../lib/Wallet.ts';
import OverlayBase from '../../overlays/OverlayBase.vue';
import { provideOverlayContentZIndex, useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { useWallets } from '../../stores/wallets.ts';
import WalletGuideAnchor from './WalletGuideAnchor.vue';
import WalletViewPrivateKey from './WalletViewPrivateKey.vue';

const props = defineProps<{
  connectorId?: string;
  wallet: WalletForEthereum;
  direction: 'left' | 'right';
  showGuidance?: boolean;
}>();
const isOpen = defineModel<boolean>('open', { default: false });
const wallets = useWallets();
const floatingZIndex = useFloatingZIndex(2);
provideOverlayContentZIndex(Vue.computed(() => floatingZIndex.value.zIndex));

const renameIsOpen = Vue.ref(false);
const exportIsOpen = Vue.ref(false);
const walletName = Vue.ref('');
const isRenaming = Vue.ref(false);
const renameError = Vue.ref('');
const chainConfig = Vue.ref<IEthereumChainConfig>();

Vue.watch(isOpen, async open => {
  if (!open || chainConfig.value) return;
  chainConfig.value = await raceWithTimeout(loadEthereumChainConfig(), 15_000, () => undefined).catch(() => undefined);
});

function openRename() {
  walletName.value = props.wallet.name;
  renameError.value = '';
  renameIsOpen.value = true;
}

async function renameWallet() {
  if (isRenaming.value) return;
  isRenaming.value = true;
  renameError.value = '';
  try {
    await wallets.ethereumWallets.rename(props.wallet, walletName.value);
    renameIsOpen.value = false;
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : 'Unable to rename the wallet.';
  } finally {
    isRenaming.value = false;
  }
}
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply hover:bg-argon-menu-hover focus:bg-argon-menu-hover flex cursor-pointer items-center justify-end gap-2 rounded px-3 py-2 font-semibold focus:outline-none;

  &[data-disabled] {
    @apply pointer-events-none text-gray-400;
  }
}
</style>
