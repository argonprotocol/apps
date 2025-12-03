<template>
  <PopoverRoot :open="isOpen">
    <PopoverPortal>
      <PopoverContent
        @escapeKeyDown="previousStep"
        ref="boxRef"
        class="absolute z-[2001] -translate-y-full"
        :style="{ left, top, width: `${props.pos.width}px` }">
        <div Arrow ref="arrowRef" class="absolute bottom-0.5 left-1/2 z-1 translate-y-full rotate-180">
          <svg
            class="relative z-10"
            width="24"
            height="12"
            viewBox="0 0 24 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0L24 12H0L12 0Z" fill="white" />
          </svg>
          <svg
            class="absolute -top-0.5 left-[-1.5px] z-0 opacity-20"
            width="26"
            height="14"
            viewBox="0 0 24 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0L24 12H0L12 0Z" fill="black" />
          </svg>
        </div>

        <div
          OverlayBox
          class="relative mx-auto flex w-[40rem] flex-col rounded-lg border border-black/60 bg-white px-4 font-light shadow-lg">
          <h3 class="mb-4 flex flex-row justify-between border-b border-slate-300/60 py-4 text-lg font-bold">
            <div class="text-lg font-bold text-slate-700">You Control Every Detail</div>
            <div class="text-slate-500/40">Step 3 of 4</div>
          </h3>

          <p>
            These six boxes contain all the configuration settings for your mining operations. Click on any box to see
            more details or make adjustments. We've set some defaults to get you started.
          </p>

          <div class="mt-3 flex flex-row justify-end space-x-3 border-t border-slate-300/60 px-3 pb-3">
            <button
              @click="previousStep"
              type="button"
              tabindex="-1"
              class="mt-4 cursor-pointer rounded-md border border-[#969AA5] bg-[#E6EAF3] px-8 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:border-slate-600 hover:bg-slate-200 focus:ring-1 focus:ring-fuchsia-500 focus:outline-none focus:ring-inset">
              Previous Step
            </button>
            <button
              @click="nextStep"
              tabindex="0"
              class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow mt-4 cursor-pointer rounded-md border px-8 py-2 text-sm font-bold text-white shadow-sm focus:outline-none">
              Next Step
            </button>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';
import { ITourPos } from '../../stores/tour.ts';

const isOpen = Vue.ref(true);

const props = defineProps<{
  pos: ITourPos;
}>();

const left = Vue.computed(() => `${props.pos.left}px`);
const top = Vue.computed(() => `${props.pos.top - 10}px`);

const emit = defineEmits(['nextStep', 'previousStep']);

function nextStep() {
  emit('nextStep');
}

function previousStep() {
  emit('previousStep');
}
</script>
