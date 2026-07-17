<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay :style="{ zIndex: overlayZIndex.backdropZIndex }" @close="closePanel" />
      </DialogOverlay>

      <DialogContent asChild @escapeKeyDown="closePanel" :aria-describedby="undefined" :style="{ zIndex: overlayZIndex.contentZIndex }">
        <div
          class="Panel inner-input-shadow bg-argon-menu-bg absolute top-[80px] bottom-[80px] left-1/2 flex w-8/12 min-w-[720px] -translate-x-1/2 flex-col overflow-auto rounded-md border border-black/30 text-left transition-all focus:outline-none"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          "
        >
          <div class="sticky top-0 mx-1 bg-white z-10 flex flex-row border-b border-slate-300 pl-5 min-h-[60px] pt-1 items-center">
            <DialogTitle class="text-2xl font-bold text-slate-800/70">Transaction History</DialogTitle>
            <div
              @click="closePanel"
              class="absolute top-[18px] right-5 z-50 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
              <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
            </div>
          </div>
          <TransactionHistory />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BgOverlay from '../components/BgOverlay.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import TransactionHistory from './portfolio/TransactionHistory.vue';
import { provideOverlayContentZIndex, useOverlayZIndex } from '../overlays/helpers/OverlayZIndex.ts';

const isOpen = Vue.ref(false);
const overlayZIndex = useOverlayZIndex(() => isOpen.value);
provideOverlayContentZIndex(Vue.toRef(overlayZIndex, 'contentZIndex'));

function closePanel() {
  isOpen.value = false;
}

basicEmitter.on('openPortfolioPanel', () => {
  if (isOpen.value) return;

  isOpen.value = true;
});
</script>
