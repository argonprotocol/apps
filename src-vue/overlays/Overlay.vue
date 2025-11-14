<!-- prettier-ignore -->
<template>
  <DialogRoot :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="closeOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="handleEscapeKeyDown" :aria-describedby="undefined" :style="{ zIndex: zIndex + 1000 }">
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <div
              :ref="draggable.setModalRef"
              :style="{
                top: `calc(50% + ${draggable.modalPosition.y}px)`,
                left: `calc(50% + ${draggable.modalPosition.x}px)`,
                transform: 'translate(-50%, -50%)',
                cursor: draggable.isDragging ? 'grabbing' : 'default',
              }"
              :class="twMerge('absolute z-50 bg-white border border-black/40 rounded-lg pointer-events-auto shadow-2xl w-6/12 overflow-scroll focus:outline-none', props.class)"
            >
              <h2
                class="flex flex-row justify-between items-center pt-5 pb-3 px-3 mx-2 text-2xl font-bold text-slate-800/70 border-b border-slate-300 select-none"
                @mousedown="draggable.onMouseDown($event)"
              >
                <slot name="title">
                  <DialogTitle class="grow pt-1">{{ title }}</DialogTitle>
                </slot>
                <DialogTitle
                  v-if="props.showCloseIcon"
                  @click="closeOverlay"
                  class="z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
                >
                  <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
                </DialogTitle>
              </h2>
              <slot />
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script lang="ts">
const openZIndexes = Vue.ref(new Set<number>());
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';

const props = withDefaults(
  defineProps<{
    title?: string;
    isOpen: boolean;
    class?: string;
    showCloseIcon?: boolean;
  }>(),
  {
    showCloseIcon: true,
  },
);

const zIndex = Vue.ref(0);

Vue.watch(props, () => {
  if (props.isOpen) {
    zIndex.value = Math.max(...openZIndexes.value, 0) + 1;
    openZIndexes.value.add(zIndex.value);
  } else {
    openZIndexes.value.delete(zIndex.value);
  }
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'esc'): void;
}>();

const draggable = Vue.reactive(new Draggable());

function closeOverlay() {
  openZIndexes.value.delete(zIndex.value);
  emit('close');
}

function handleEscapeKeyDown() {
  emit('esc');
  closeOverlay();
}
</script>
