<template>
  <svg
    :height="props.size"
    :width="props.size"
    :viewBox="`0 0 ${props.size} ${props.size}`"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle
      :cx="props.size / 2"
      :cy="props.size / 2"
      :r="props.size / 2"
      :fill="definition.color"
      :opacity="definition.backgroundOpacity"
    />
    <g :transform="`translate(${translate}, ${translate}) scale(${scale})`">
      <path
        v-for="(path, index) in definition.paths"
        :key="index"
        :d="path"
        :fill="definition.color"
        clip-rule="evenodd"
        fill-rule="evenodd"
      />
    </g>
  </svg>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getUniconDefinition } from '../lib/Unicon.ts';

const props = withDefaults(
  defineProps<{
    address: string;
    size?: number;
    isDark?: boolean;
  }>(),
  {
    size: 40,
    isDark: false,
  },
);

const definition = Vue.computed(() => getUniconDefinition(props.address, props.isDark));
const scale = Vue.computed(() => props.size / 48 / 1.5);
const translate = Vue.computed(() => (props.size - 48 * scale.value) / 2);
</script>
