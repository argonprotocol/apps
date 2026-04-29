<!-- prettier-ignore -->
<template>
  <DialogRoot :open="isOpen">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion
            asChild
            :initial="disableOverlayMotion ? false : { opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }">
            <BgOverlay @close="clickBackdrop" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="handleEscapeKeyDown" :aria-describedby="undefined" :style="{ zIndex: zIndex + 1000 }">
          <Motion
            asChild
            :initial="disableOverlayMotion ? false : { opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }">
            <div
              :ref="draggable.setModalRef"
              v-bind="attrs"
              :style="{
                top: `calc(50% + ${draggable.modalPosition.y}px)`,
                left: `calc(50% + ${draggable.modalPosition.x}px)`,
                transform: 'translate(-50%, -50%)',
                cursor: draggable.isDragging ? 'grabbing' : 'default',
              }"
              :class="twMerge(
                'absolute z-50 pointer-events-auto min-h-40 w-6/12 focus:outline-none',
                IS_TREASURY_APP ? 'ml-[160px]' : '',
                props.leaveBlank ? '' : 'bg-white border border-black/40 rounded-lg shadow-2xl',
                props.overflowScroll ? 'flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden' : '',
                props.class,
              )"
            >
              <h2
                v-if="!props.leaveBlank"
                :class="[props.showGoBack ? 'pb-4 px-3' : 'pb-3 pl-2 pr-3', props.hasHeaderBorder ? 'border-b' : '']"
                class="z-20 flex flex-row items-center justify-between border-slate-300 pt-5 mx-2 gap-x-3 text-2xl font-bold text-slate-800/70 select-none shrink-0"
                @mousedown="draggable.onMouseDown($event)"
              >
                <span v-if="props.showGoBack" @click="goBack()" class="flex flex-row items-center hover:bg-[#f1f3f7] rounded-md p-1 pl-0 mr-2 cursor-pointer">
                  <ChevronLeftIcon class="w-6 h-6 cursor-pointer relative -top-0.25" />
                </span>
                <slot name="title">
                  <DialogTitle class="grow pt-1">{{ title }}</DialogTitle>
                </slot>
                <span class="flex flex-row justify-end items-center">
                  <DialogClose
                    NotDraggable
                    v-if="props.showCloseIcon"
                    @click="clickClose"
                    class="z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[34px] h-[34px] focus:outline-none border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
                  >
                    <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4 pointer-events-none" />
                  </DialogClose>
                </span>
              </h2>
              <div :class="props.overflowScroll ? 'min-h-0 grow overflow-y-auto overflow-x-hidden' : ''">
                <slot />
              </div>
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
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogClose } from 'reka-ui';
import { AnimatePresence, Motion, MotionGlobalConfig } from 'motion-v';
import { ChevronLeftIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import { IS_TREASURY_APP } from '../../lib/Env.ts';
import BgOverlay from '../../components/BgOverlay.vue';
import Draggable from '../../app-operations/overlays/helpers/Draggable.ts';

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(
  defineProps<{
    title?: string;
    isOpen: boolean;
    class?: string;
    showCloseIcon?: boolean;
    showGoBack?: boolean;
    disallowClose?: boolean;
    overflowScroll?: boolean;
    leaveBlank?: boolean;
    hasHeaderBorder?: boolean;
  }>(),
  {
    showCloseIcon: true,
    showGoBack: false,
    overflowScroll: true,
    hasHeaderBorder: true,
  },
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'pressEsc'): void;
  (e: 'clickClose'): void;
  (e: 'clickBackdrop'): void;
  (e: 'goBack'): void;
}>();

const zIndex = Vue.ref(0);
const attrs = Vue.useAttrs();
const disableOverlayMotion = MotionGlobalConfig.skipAnimations || MotionGlobalConfig.instantAnimations;

Vue.watch(
  () => props.isOpen,
  isOpen => {
    if (!isOpen) {
      openZIndexes.value.delete(zIndex.value);
      return;
    }

    zIndex.value = Math.max(...openZIndexes.value, 0) + 1;
    openZIndexes.value.add(zIndex.value);
  },
  { immediate: true },
);

Vue.onUnmounted(() => {
  openZIndexes.value.delete(zIndex.value);
});

const draggable = Vue.reactive(new Draggable());

function closeOverlay() {
  if (props.disallowClose) {
    return;
  }
  emit('close');
}

function clickClose() {
  emit('clickClose');
  closeOverlay();
}

function clickBackdrop() {
  emit('clickBackdrop');
  closeOverlay();
}

function goBack() {
  emit('goBack');
}

function handleEscapeKeyDown() {
  emit('pressEsc');
  closeOverlay();
}

defineExpose({
  draggable,
});
</script>
