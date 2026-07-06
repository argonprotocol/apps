<template>
  <div class="flex grow flex-row items-center gap-x-2">
    <header class="grow px-2 text-left text-xl font-bold text-slate-800/70">
      {{ props.selectedOption.name }}
    </header>
    <div
      v-if="!isSyncMode"
      NotDraggable
      @click="triggerSyncMode"
      class="z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <PortalIcon class="pointer-events-none h-5 w-5 text-slate-500/60" />
    </div>
    <ExtraMenu
      :walletType="walletType"
      :wallet="props.wallet"
      :walletIsOpen="true"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
    />
    <DialogClose
      v-if="showClose"
      NotDraggable
      @click="close"
      class="z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
    </DialogClose>
  </div>
</template>

<script lang="ts">
import { WalletType } from '../../lib/Wallet.ts';

export interface IWalletOption {
  type: WalletType.defaultArgon | WalletType.ethereum;
  name: string;
  isArgonNetwork: boolean;
}
</script>

<script setup lang="ts">
import { DialogClose } from 'reka-ui';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import ExtraMenu from './ExtraMenu.vue';
import PortalIcon from '../../assets/wallets/swap.svg';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'selectOption', option: IWalletOption): void;
  (e: 'triggerSyncMode'): void;
}>();

const props = defineProps<{
  wallet: { address: string };
  walletType: WalletType;
  options: IWalletOption[];
  selectedOption: IWalletOption;
  isSyncMode?: boolean;
  showClose?: boolean;
}>();

function close() {
  emit('close');
}

function triggerSyncMode() {
  emit('triggerSyncMode');
}
</script>
