<!-- prettier-ignore -->
<template>
  <div
    ref="$el"
    SelectedLine
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    :style="`left: ${posLeft}px`"
    :class="lineClasses"
    class="absolute bottom-1 cursor-col-resize z-10 -top-1 rounded-t-md"
  >
    <div class="Selected"></div>
    <div NibWrapper class="absolute left-1/2 -bottom-0 ml-[1.5px] w-[26.5px] h-6 -translate-x-1/2 translate-y-1/2">
      <TriangleNib class="absolute left-0 bottom-0 w-[24.5px] h-6 cursor-grab" />
      <TriangleNibBasic class="Selected absolute left-[2.5px] bottom-1 w-[18px] h-4 pointer-events-none" />
    </div>

    <!-- <div nib-handle :style="{ left: `${percentOfYear}%` }" class="absolute -top-1 -bottom-1 w-2 bg-white rounded-full border border-slate-400/50 shadow-md z-10">
      <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full border border-slate-400/50 shadow-md"></div>
    </div> -->
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import TriangleNib from '../assets/triangle-nib.svg?component';
import TriangleNibBasic from '../assets/triangle-nib-basic.svg?component';

const props = defineProps<{
  position: 'left' | 'right';
  pos: number;
  isActive: boolean;
}>();

const emit = defineEmits<{
  (e: 'pointerdown', event: PointerEvent): void;
  (e: 'pointermove', event: PointerEvent): void;
  (e: 'pointerup', event: PointerEvent): void;
}>();

const $el = Vue.ref<HTMLElement | null>(null);
const posLeft = Vue.computed(() => props.pos);

const posTopPct = Vue.computed(() => {
  const viewportWidth = window.innerWidth;
  const leftPct = (props.pos / viewportWidth) * 100;
  const noAdjustmentAfter = 70;

  if (leftPct < 40) {
    return 77;
  } else if (leftPct > noAdjustmentAfter) {
    return 20;
  } else {
    const scale = (leftPct - 40) / (noAdjustmentAfter - 40); // 0 to 1
    return 80 - scale * (80 - 20); // Scale between 80 and 20
  }
});

const lineClasses = Vue.computed(() => {
  return {
    isActive: props.isActive,
    Left: props.position === 'left',
    Right: props.position === 'right',
  };
});

const chartOpaqueStyle = Vue.computed(() => {
  if (props.position === 'left') {
    return { width: `${props.pos - 10}px`, left: '10px' };
  } else {
    return { left: `${props.pos}px`, right: '10px' };
  }
});

function onPointerDown(event: PointerEvent) {
  const elem = $el.value;
  if (!elem) return;

  elem.onpointermove = emitDrag;
  elem.setPointerCapture(event.pointerId);
  emit('pointerdown', event);
}

function emitDrag(event: PointerEvent) {
  emit('pointermove', event);
}

function onPointerUp(event: PointerEvent) {
  const elem = $el.value;
  if (!elem) return;

  elem.onpointermove = null;
  elem.releasePointerCapture(event.pointerId);
  emit('pointerup', event);
}

defineExpose({ $el });
</script>

<style lang="scss" scoped>
[SelectedLine] {
  background: rgba(255, 255, 255, 1);
  width: 5px;
  border-top: 1px solid rgba(30, 41, 59, 0.4);

  &:before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -1px;
    width: 1px;
    background: rgba(30, 41, 59, 0.4);
  }
  &:after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    right: -1px;
    width: 1px;
    background: rgba(30, 41, 59, 0.4);
    z-index: -1;
  }
  div.Selected {
    display: none;
    position: absolute;
    width: 2px;
    left: 1px;
    top: 0;
    height: 100%;
    background: rgb(204, 136, 255);
  }

  svg.Selected {
    display: none;
  }
  &.isActive {
    svg.Selected {
      display: block;
    }
    div.Selected {
      display: block;
    }
  }

  &.Left {
    box-shadow: -1px 0 4px 0px rgba(0, 0, 0, 0.1);
  }

  &.Right {
    box-shadow: 1px 0 4px 0px rgba(0, 0, 0, 0.1);
  }
}
</style>
