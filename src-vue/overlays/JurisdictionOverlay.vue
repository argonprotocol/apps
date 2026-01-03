<!-- prettier-ignore -->
<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="closeOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="closeOverlay" :aria-describedby="undefined">
          <Motion
            :ref="draggable.setModalRef"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            class="absolute z-50 bg-white border border-black/40 px-3 pt-6 pb-4 rounded-lg shadow-xl w-160 min-h-60 overflow-scroll focus:outline-none"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
          >
            <h2
              :class="[currentScreen === 'overview' ? 'pb-4 mb-5 px-3' : 'pb-3 pl-2 pr-3 mb-6']"
              class="flex flex-row justify-between items-center text-2xl font-bold text-slate-800/70 border-b border-slate-300 select-none"
              @mousedown="draggable.onMouseDown($event)"
            >
              <div v-if="currentScreen !== 'overview'" class="flex flex-row items-center hover:bg-[#f1f3f7] rounded-md p-1 pl-0 mr-2 cursor-pointer">
                <ChevronLeftIcon @click="goTo('overview')" class="w-6 h-6 cursor-pointer relative -top-0.25" />
              </div>
              <DialogTitle class="grow">{{ title }}</DialogTitle>
              <DialogClose
                @click="closeOverlay"
                class="z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
              >
                <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
              </DialogClose>
            </h2>

            <JurisdictionalOverview v-if="currentScreen === 'overview'" @close="closeOverlay" @goTo="goTo" />
            <FixJurisdiction v-if="currentScreen === 'fixJurisdiction'" @close="closeOverlay" @goTo="goTo" />
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter';
import BgOverlay from '../components/BgOverlay.vue';
import JurisdictionalOverview from './compliance/Overview.vue';
import FixJurisdiction from './compliance/FixJurisdiction.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogClose } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import Draggable from './helpers/Draggable.ts';

const isOpen = Vue.ref(false);
const currentScreen = Vue.ref<'overview' | 'fixJurisdiction'>('overview');
const draggable = Vue.reactive(new Draggable());

const title = Vue.computed(() => {
  if (currentScreen.value === 'overview') {
    return 'Default Jurisdiction';
  } else if (currentScreen.value === 'fixJurisdiction') {
    return 'Fix Your Country of Residence';
  }
});

basicEmitter.on('openJurisdictionOverlay', async (data: any) => {
  isOpen.value = true;
  currentScreen.value = 'overview';
  draggable.modalPosition.x = 0;
  draggable.modalPosition.y = 0;
});

function closeOverlay() {
  isOpen.value = false;
}

function goTo(screen: 'overview' | 'fixJurisdiction') {
  currentScreen.value = screen;
}
</script>
