<template>
  <svg
    :class="twMerge('block h-3.5 w-6', props.class)"
    class="Component Arrow"
    :style="{ height: cssSize(props.height), width: cssSize(props.width) }"
    viewBox="0 0 18 10"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <defs v-if="shadow">
      <filter id="arrow-shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.3" />
      </filter>
    </defs>
    <path
      d="M 0 10 L 9 0 L 18 10 Z"
      :stroke="stroke"
      :stroke-width="strokeWidth"
      vector-effect="non-scaling-stroke"
      stroke-linejoin="round"
      :filter="shadow ? 'url(#arrow-shadow)' : undefined"
    />
  </svg>
</template>

<script setup lang="ts">
import { twMerge } from 'tailwind-merge';
const props = withDefaults(
  defineProps<{
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    shadow?: boolean;
    height?: number | string;
    width?: number | string;
    class?: string;
  }>(),
  {
    fill: '#ffffff',
    stroke: '#d1d5db',
    strokeWidth: 1,
    shadow: false,
  },
);

function cssSize(value: number | string | undefined) {
  if (typeof value === 'number') {
    return `${value}px`;
  }
  return value;
}
</script>

<style scoped>
svg path {
  fill: v-bind(fill);
}
</style>
