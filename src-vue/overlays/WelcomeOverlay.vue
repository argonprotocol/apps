<!-- prettier-ignore -->
<template>
  <DialogRoot :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay />
          </Motion>
        </DialogOverlay>
        
        <DialogContent asChild :aria-describedby="undefined">
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <div 
              :ref="draggable.setModalRef"
              :style="{
                top: `calc(50% + ${draggable.modalPosition.y}px)`,
                left: `calc(50% + ${draggable.modalPosition.x}px)`,
                transform: 'translate(-50%, -50%)',
                cursor: draggable.isDragging ? 'grabbing' : 'default',
              }"
              class="absolute z-50 bg-white border border-black/40 rounded-lg pointer-events-auto shadow-2xl w-6/12 overflow-scroll focus:outline-none"
            >
              <h2
                class="flex flex-row justify-between items-center py-4 px-5 mx-2 text-2xl font-bold text-slate-800/70 border-b border-slate-300 select-none"
                @mousedown="draggable.onMouseDown($event)"
              >
                <DialogTitle class="grow pt-1">Welcome to Argon Investor Console</DialogTitle>
              </h2>
              <div class="mx-2 pl-5 pr-10 pt-5 space-y-3 font-light leading-6">
                <p>
                  You might already be familiar with Argon, but in case you're not: Argon is the first crypto asset 
                  designed to remain truly stable. It achieves this with zero off-chain collateral and zero centralized control. Argon is a 
                  breakthrough in the quest for a global currency that's free from inflation and the debt-ridden nature of fiat money.
                </p>

                <p>
                  This app is built for a select group of early insiders who want to participate in running Argon's blockchain -- whether by 
                  mining new blocks or by vaulting to help stabilize the currency. Argon Investor guides you through setting up operations, handling 
                  governance, and monitoring your capital flows. We recommend starting with the quick tour to get familiar.
                </p>
              </div>
              <div class="flex flex-row justify-end items-center border-t border-slate-300 py-5 px-5 mt-5 space-x-2 mx-2">
                <button @click="closeOverlay" tabindex="-1" class="bg-white border border-argon-600/50 hover:bg-argon-600/10 text-argon-600 font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
                  Close Overlay
                </button>
                <button @click="startTour" tabindex="0" class="flex flex-row items-center space-x-2 bg-argon-button border border-argon-button-hover hover:bg-argon-button-hover text-white font-bold inner-button-shadow px-12 py-2 rounded-md cursor-pointer focus:outline-none">
                  <span>Take the Tour</span>
                  <ChevronDoubleRightIcon class="size-5 relative top-px text-white" />
                </button>
              </div>
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import { useConfig } from '../stores/config';
import { useTour } from '../stores/tour';

const config = useConfig();
const tour = useTour();

const draggable = Vue.reactive(new Draggable());
const isOpen = Vue.ref(config.showWelcomeOverlay);

function closeOverlay() {
  config.showWelcomeOverlay = false;
}

function startTour() {
  tour.start();
}
</script>
