<!-- prettier-ignore -->
<template>
  <TransitionRoot class="absolute inset-0 z-10 pointer-events-none" :show="isOpen">
    <TransitionChild
      as="template"
      enter="ease-out duration-300"
      enter-from="opacity-0"
      enter-to="opacity-100"
      leave="ease-in duration-200"
      leave-from="opacity-100"
      leave-to="opacity-0"
    >
      <BgOverlay :enableTopBar="true" />
    </TransitionChild>

    <div class="absolute inset-0 z-100 overflow-y-auto pt-[1px] flex items-center justify-center pointer-events-none">
      <TransitionChild
        as="template"
        enter="ease-out duration-300"
        enter-from="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
        enter-to="opacity-100 translate-y-0 sm:scale-100"
        leave="ease-in duration-200"
        leave-from="opacity-100 translate-y-0 sm:scale-100"
        leave-to="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
      >
        <div
          :ref="draggable.setModalRef"
          :style="{
            top: `calc(50% + ${draggable.modalPosition.y}px)`,
            left: `calc(50% + ${draggable.modalPosition.x}px)`,
            transform: 'translate(-50%, -50%)',
          }"
          class="absolute flex flex-col w-6/12 bg-white border border-black/40 px-7 pb-8 rounded-lg pointer-events-auto shadow-xl overflow-scroll"
        >
          <h2 
            @mousedown="draggable.onMouseDown($event)" 
            :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
            class="text-2xl font-bold text-slate-800/70 border-b border-slate-300 pt-6 pb-3 mb-3"
          >
            Syncing Your Mining Machine
          </h2>
          <div v-if="syncErrorType" class="flex flex-row items-center gap-x-2">
            <AlertIcon class="w-4 h-4 text-red-600 relative inline-block" />
            <div class="text-red-500">There was an error syncing your mining machine.</div>
            <button
              class="text-red-500 border border-red-500 rounded-md px-3 text-md cursor-pointer hover:bg-red-500 hover:text-white"
              @click="retrySync"
            >
              {{ isRetrying ? 'Retrying...' : 'Retry' }}
            </button>
          </div>
          <ProgressBar :progress="bot.syncProgress" class="mt-3" />
        </div>
      </TransitionChild>
    </div>
  </TransitionRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TransitionChild, TransitionRoot } from '@headlessui/vue';
import BgOverlay from '../components/BgOverlay.vue';
import ProgressBar from '../components/ProgressBar.vue';
import AlertIcon from '../assets/alert.svg?component';
import { getBot } from '../stores/bot';
import Draggable from './helpers/Draggable.ts';

const isOpen = Vue.ref(true);
const isRetrying = Vue.ref(false);
const bot = getBot();

const draggable = Vue.reactive(new Draggable());

const syncErrorType = Vue.ref<string | null>(null);

async function retrySync() {
  isRetrying.value = true;
  // stats.retrySync();
  isRetrying.value = false;
}
</script>
