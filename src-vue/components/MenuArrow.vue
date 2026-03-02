<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true">
    <path :d="path" :fill="fill" :stroke="stroke" stroke-linejoin="round" />
  </svg>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const props = withDefaults(
  defineProps<{
    width?: number;
    height?: number;
    direction?: 'up' | 'down';
    fill?: string;
    stroke?: string;
  }>(),
  {
    width: 18,
    height: 10,
    direction: 'up',
    fill: '#ffffff',
    stroke: '#d1d5db',
  },
);

const path = Vue.computed(() => {
  if (props.direction === 'down') {
    return `M 0 0 L ${props.width / 2} ${props.height} L ${props.width} 0 Z`;
  }

  return `M 0 ${props.height} L ${props.width / 2} 0 L ${props.width} ${props.height} Z`;
});
</script>
