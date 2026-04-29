<template>
  <svg
    ref="svgEl"
    :class="twMerge('block h-[92px] w-[74px]', props.class)"
    :viewBox="`0 0 ${size.width} ${size.height}`"
    fill="none"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path
      :d="curvePath"
      :stroke="props.color"
      :stroke-width="props.strokeWidth"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <path
      :d="arrowHeadPath"
      :stroke="props.color"
      :stroke-width="props.strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';

const props = withDefaults(
  defineProps<{
    class?: string;
    color?: string;
    strokeWidth?: number;
  }>(),
  {
    color: 'currentColor',
    strokeWidth: 3,
  },
);

const svgEl = Vue.ref<SVGSVGElement | null>(null);
const size = Vue.ref({ width: 74, height: 92 });

const curvePath = Vue.computed(() => {
  const width = size.value.width;
  const height = size.value.height;
  const inset = Math.max(props.strokeWidth / 2 + 1, 2);
  const headSize = Math.min(width * 0.12, 10, Math.max((height - inset * 2) * 0.18, 6));
  const arrowJoinX = width * 0.27;
  const arrowJoinY = inset + headSize;
  const startX = width * 0.56;
  const startY = height - inset;

  return [
    `M${startX} ${startY}`,
    `C${width * 0.86} ${height * 0.72} ${width * 0.82} ${height * 0.42} ${width * 0.64} ${height * 0.24}`,
    `C${width * 0.52} ${height * 0.12} ${width * 0.38} ${height * 0.14} ${arrowJoinX} ${arrowJoinY}`,
  ].join('');
});

const arrowHeadPath = Vue.computed(() => {
  const width = size.value.width;
  const height = size.value.height;
  const inset = Math.max(props.strokeWidth / 2 + 1, 2);
  const arrowJoinX = width * 0.16;
  const headSize = Math.min(width * 0.12, 10, Math.max((height - inset * 2) * 0.18, 6));
  const arrowJoinY = inset + headSize;

  return [
    `M${arrowJoinX + headSize} ${arrowJoinY - headSize}`,
    `L${arrowJoinX} ${arrowJoinY}`,
    `L${arrowJoinX + headSize} ${arrowJoinY + headSize}`,
  ].join('');
});

function updateSize() {
  if (!svgEl.value) return;
  const { width, height } = svgEl.value.getBoundingClientRect();
  if (!width || !height) return;
  size.value = { width, height };
}

let resizeObserver: ResizeObserver | undefined;

Vue.onMounted(() => {
  updateSize();
  if (!svgEl.value) return;

  resizeObserver = new ResizeObserver(() => {
    updateSize();
  });
  resizeObserver.observe(svgEl.value);
});

Vue.onUnmounted(() => {
  resizeObserver?.disconnect();
});
</script>
