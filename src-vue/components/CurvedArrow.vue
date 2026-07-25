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
    dynamic?: boolean;
    strokeWidth?: number;
  }>(),
  {
    color: 'currentColor',
    strokeWidth: 3,
  },
);

const svgEl = Vue.ref<SVGSVGElement | null>(null);
const size = Vue.ref({ width: 74, height: 92 });
const dynamicPoints = Vue.ref<{
  start: { x: number; y: number };
  end: { x: number; y: number };
}>();

const curvePath = Vue.computed(() => {
  if (dynamicPoints.value) {
    const { start, end } = dynamicPoints.value;
    const controlX = Math.max(start.x, end.x) + Math.max(Math.abs(start.y - end.y) * 0.35, 28);

    return `M${start.x} ${start.y}C${controlX} ${start.y - 24} ${controlX} ${end.y} ${end.x} ${end.y}`;
  }

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
  if (dynamicPoints.value) {
    const { end } = dynamicPoints.value;
    const headSize = Math.max(props.strokeWidth * 2.5, 8);

    return `M${end.x + headSize} ${end.y - headSize}L${end.x} ${end.y}L${end.x + headSize} ${end.y + headSize}`;
  }

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

  if (!props.dynamic) {
    dynamicPoints.value = undefined;
    return;
  }

  const container = svgEl.value.parentElement;
  const startElement = container?.querySelector<HTMLElement>('[data-curved-arrow-start]');
  const endElement = container?.querySelector<HTMLElement>('[data-curved-arrow-end]');
  if (!startElement || !endElement) return;

  const svgRect = svgEl.value.getBoundingClientRect();
  const startRect = startElement.getBoundingClientRect();
  const endRect = endElement.getBoundingClientRect();
  dynamicPoints.value = {
    start: {
      x: startRect.right - svgRect.left + 8,
      y: startRect.top - svgRect.top + 4,
    },
    end: {
      x: endRect.right - svgRect.left + 12,
      y: endRect.top - svgRect.top + endRect.height / 2,
    },
  };
}

let resizeObserver: ResizeObserver | undefined;

Vue.onMounted(() => {
  updateSize();
  if (!svgEl.value) return;

  resizeObserver = new ResizeObserver(() => {
    updateSize();
  });
  resizeObserver.observe(svgEl.value);

  if (props.dynamic) {
    const container = svgEl.value.parentElement;
    const startElement = container?.querySelector<HTMLElement>('[data-curved-arrow-start]');
    const endElement = container?.querySelector<HTMLElement>('[data-curved-arrow-end]');
    if (container) resizeObserver.observe(container);
    if (startElement) resizeObserver.observe(startElement);
    if (endElement) resizeObserver.observe(endElement);
  }
});

Vue.onUnmounted(() => {
  resizeObserver?.disconnect();
});
</script>
