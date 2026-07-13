<template>
  <div class="flex grow flex-row items-center gap-x-2">
    <header class="grow px-2 text-left text-xl font-bold text-slate-800/70">
      {{ props.name }}
    </header>
    <ExtraMenu
      :walletType="walletType"
      :wallet="props.wallet"
      :walletIsOpen="true"
      :canExportPrivateKey="props.canExportPrivateKey"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
    />
    <button
      v-if="showClose"
      NotDraggable
      type="button"
      @click="close"
      class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <span v-if="props.closeSide === 'left'" data-testid="WalletOverlay.closeLeft()" class="absolute inset-0 z-10" />
      <span v-else data-testid="WalletOverlay.closeRight()" class="absolute inset-0 z-10" />
      <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { XMarkIcon } from '@heroicons/vue/24/outline';
import ExtraMenu from './ExtraMenu.vue';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const props = defineProps<{
  wallet: IWallet;
  walletType: WalletType;
  name: string;
  canExportPrivateKey?: boolean;
  showClose?: boolean;
  closeSide: 'left' | 'right';
}>();

function close() {
  emit('close');
}
</script>
