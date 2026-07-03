<template>
  <div class="flex grow flex-row items-center gap-x-2">
    <header class="grow px-2 text-left text-2xl font-bold text-slate-800/70">
      {{ props.selectedOption.name }}
    </header>
    <div
      data-testid="NavHeader.triggerSyncMode()"
      @click="emit('triggerSyncMode')"
      class="z-10 flex h-[34px] w-[34px] cursor-pointer flex-col items-center justify-center gap-y-0.5 rounded-md border border-slate-400/60 text-slate-500/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
    >
      <span class="h-1 w-1 rounded-full bg-current" />
      <span class="h-1 w-1 rounded-full bg-current" />
      <span class="h-1 w-1 rounded-full bg-current" />
    </div>
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
  type: WalletType.investment | WalletType.ethereum | WalletType.vaulting | WalletType.miningHold;
  name: string;
  isArgonNetwork: boolean;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogClose } from 'reka-ui';
import CopyAddressMenu from '../../screens/components/CopyAddressMenu.vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'selectOption', option: IWalletOption): void;
  (e: 'triggerSyncMode'): void;
}>();

const props = defineProps<{
  options: IWalletOption[];
  selectedOption: IWalletOption;
  showClose?: boolean;
}>();

function close() {
  emit('close');
}
</script>
