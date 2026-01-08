<!-- prettier-ignore -->
<template>
  <div :class="[roundedClass]" class="absolute top-0 left-0 w-full h-full pointer-events-none z-30">
    <div v-if="enableTopBar" :class="[roundedTopClass]" class="absolute top-0 left-0 w-full h-14 pointer-events-none bg-black/20 transition-opacity"></div>
    <div
      @click="emitClose"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      class="absolute bg-black/20 transition-opacity pointer-events-auto"
      :class="[enableTopBar ? 'top-14 bottom-0 inset-x-0' : 'inset-0', enableTopBar ? roundedBottomClass : roundedClass]"
      data-tauri-drag-region
    >
      <div v-if="showWindowControls && !enableTopBar" @click.stop class="absolute left-0" :class="[getPlatform() === 'macos' ? 'top-[22px]' : 'top-[16px]']">
        <WindowControls />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import WindowControls from '../tauri-controls/WindowControls.vue';
import { platform as getPlatform } from '@tauri-apps/plugin-os';

const props = withDefaults(
  defineProps<{
    showWindowControls?: boolean;
    enableTopBar?: boolean;
    rounded?: 'none' | 'sm' | 'md' | 'lg';
  }>(),
  {
    showWindowControls: true,
    enableTopBar: false,
    rounded: 'lg',
  },
);

const roundedClass = Vue.computed(() => {
  return props.rounded === 'none' ? '' : `rounded-${props.rounded}`;
});

const roundedTopClass = Vue.computed(() => {
  return props.rounded === 'none' ? '' : `rounded-t-${props.rounded}`;
});

const roundedBottomClass = Vue.computed(() => {
  return props.rounded === 'none' ? '' : `rounded-b-${props.rounded}`;
});

const emit = defineEmits(['close']);
const DRAG_THRESHOLD = 5;

let dragStartX = 0;
let dragStartY = 0;
let wasDragged = false;

function emitClose(e: MouseEvent) {
  if (wasDragged) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  emit('close');
}

function handlePointerDown(e: PointerEvent) {
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  wasDragged = false;
}

function handlePointerMove(e: PointerEvent) {
  if (Math.abs(e.screenX - dragStartX) > DRAG_THRESHOLD || Math.abs(e.screenY - dragStartY) > DRAG_THRESHOLD) {
    wasDragged = true;
  }
}
</script>
