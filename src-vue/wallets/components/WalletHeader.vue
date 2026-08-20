<template>
  <h2
    :style="{ cursor: props.isDragging ? 'grabbing' : 'grab' }"
    class="z-20 mx-1 flex shrink-0 flex-row items-center gap-x-2.5 border-b border-slate-400/50 pt-3 pr-3 pb-2 pl-2 text-2xl font-bold text-slate-800/70 select-none"
    @mousedown="emit('dragStart', $event)"
  >
    <span class="min-w-0 grow px-1 text-left text-xl font-bold text-slate-800/70">Internal App Wallet</span>
    <CopyToClipboard
      NotDraggable
      :content="defaultArgonWallet.address"
      class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <CopyIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
      <template #copying>
        <div class="flex h-full w-full items-center justify-center rounded-md bg-[#f1f3f7]">
          <CheckIcon class="pointer-events-none h-5 w-5 stroke-2 text-green-600" />
        </div>
      </template>
    </CopyToClipboard>
    <WalletMenu
      :selection="defaultArgonSelection"
      :wallet="defaultArgonWallet"
      :walletIsOpen="true"
      :showBorders="true"
      :testIdPrefix="'defaultArgonWalletAddress'"
      class="h-[34px] shrink-0"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
    />
    <button
      NotDraggable
      data-testid="WalletOverlay.closeRight()"
      @click="emit('close')"
      class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
    </button>
  </h2>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { CheckIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../../assets/copy.svg';
import { WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';
import type { IWalletSelection } from '../walletOverlayState.ts';
import WalletMenu from './WalletMenu.vue';

const props = defineProps<{ isDragging: boolean }>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'close'): void;
}>();

const wallets = useWallets();
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const defaultArgonSelection = { walletType: WalletType.defaultArgon } satisfies IWalletSelection;
</script>
