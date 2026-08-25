<template>
  <h2
    :style="{ cursor: props.isDragging ? 'grabbing' : 'grab' }"
    class="z-20 mx-1 flex shrink-0 flex-row items-center gap-x-2.5 border-b border-slate-400/50 pt-3 pr-3 pb-2 pl-2 text-2xl font-bold text-slate-800/70 select-none"
    @mousedown="emit('dragStart', $event)"
  >
    <span class="flex grow flex-row items-center">
      <span
        v-if="props.showHome"
        class="group hover:bg-argon-100/20 flex h-8 cursor-pointer flex-row items-center rounded-md py-1 pr-2 pl-1"
      >
        <BackIcon
          @click="emit('goto', 'main')"
          class="relative -top-0.25 w-4 cursor-pointer opacity-50 group-hover:opacity-100"
        />
      </span>
      <span class="min-w-0 grow text-left text-xl font-bold text-slate-800/70">{{ props.name }}</span>
    </span>
    <ButtonCopy :address="defaultArgonWallet.address" />
    <WalletMenu
      :wallet="defaultArgonWallet"
      :walletIsOpen="true"
      :showBorders="true"
      :testIdPrefix="'defaultArgonWalletAddress'"
      class="h-[34px] shrink-0"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
    />
    <ButtonClose @close="emit('close')" />
  </h2>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import BackIcon from '../../assets/back.svg';
import { useWallets } from '../../stores/wallets.ts';
import type { IWalletView } from '../walletOverlayState.ts';
import WalletMenu from './WalletMenu.vue';
import ButtonCopy from './ButtonCopy.vue';
import ButtonClose from './ButtonClose.vue';

const props = defineProps<{
  name: string;
  isDragging: boolean;
  showHome?: boolean;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'close'): void;
  (event: 'goto', view: IWalletView): void;
}>();

const wallets = useWallets();

const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
</script>
