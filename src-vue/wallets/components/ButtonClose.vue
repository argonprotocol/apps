<template>
  <button
    NotDraggable
    data-testid="WalletOverlay.closeRight()"
    @click="emit('close')"
    class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
  >
    <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
  </button>
</template>

<script setup lang="ts">
import { XMarkIcon } from '@heroicons/vue/24/outline';
import type { IWalletView } from '../walletOverlayState.ts';

const emit = defineEmits<{
  (event: 'close'): void;
}>();
</script>