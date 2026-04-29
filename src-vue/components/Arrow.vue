<template>
  <svg
    :class="twMerge('block h-3.5 w-6', props.class)"
    class="Component Arrow"
    viewBox="0 0 18 10"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path
      d="M 0 10 L 9 0 L 18 10 Z"
      :stroke="stroke"
      :stroke-width="strokeWidth"
      vector-effect="non-scaling-stroke"
      stroke-linejoin="round"
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
    class?: string;
  }>(),
  {
    fill: '#ffffff',
    stroke: '#d1d5db',
    strokeWidth: 1,
  },
);
</script>

<style scoped>
svg path {
  fill: v-bind(fill);
}
</style>
