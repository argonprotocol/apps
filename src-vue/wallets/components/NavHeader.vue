<template>
  <div class="flex min-w-0 grow flex-row items-center gap-x-2.5">
    <WalletSelector
      :selectedWallet="props.selection"
      :walletSelections="props.walletSelections"
      :testIdPrefix="`WalletOverlay.${props.closeSide}WalletMenu`"
      class="min-w-0 grow px-2 text-left text-xl font-bold text-slate-800/70"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
      @select="emit('select', $event)"
    />
    <WalletActions
      :selection="props.selection"
      :wallet="props.wallet"
      :walletIsOpen="true"
      :showBorders="true"
      :canExportPrivateKey="props.canExportPrivateKey"
      :walletAddressTestId="walletAddressTestId"
      class="h-[34px] shrink-0"
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
import { computed } from 'vue';
import { type IWallet, WalletType } from '../../lib/Wallet.ts';
import WalletActions from './WalletActions.vue';
import WalletSelector from './WalletSelector.vue';
import { getWalletSelectionKey, type IWalletSelection } from '../walletOverlayState.ts';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'select', wallet: IWalletSelection): void;
}>();

const props = defineProps<{
  wallet: IWallet;
  selection: IWalletSelection;
  walletSelections: IWalletSelection[];
  canExportPrivateKey?: boolean;
  showClose?: boolean;
  closeSide: 'left' | 'right';
}>();

const walletAddressTestId = computed(() => {
  if (props.selection.walletType === WalletType.defaultArgon) return 'defaultArgonWalletAddress';
  return `WalletOverlay.${props.closeSide}.${getWalletSelectionKey(props.selection)}Address`;
});

function close() {
  emit('close');
}
</script>
