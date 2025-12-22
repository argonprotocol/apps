<script setup lang="ts">
import { twMerge } from 'tailwind-merge';
import Gnome from './controls/linux/Gnome.vue';
import MacOs from './controls/MacOs.vue';
import Windows from './controls/Windows.vue';
import type { WindowControlsProps } from './types';
import { platformType } from './utils/os';

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(defineProps<WindowControlsProps>(), {
  justify: false,
  hide: false,
  hideMethod: 'display',
  className: '',
});

let platform = props.platform || platformType;

const customClass = twMerge(
  'flex pointer-events-auto focus:outline-none',
  props.className,
  props.hide && (props.hideMethod === 'display' ? 'hidden' : 'invisible'),
);
</script>

<template>
  <MacOs v-if="platform === 'macos'" :class="twMerge(customClass, props.justify && 'ml-0')" />
  <Gnome v-else-if="platform === 'gnome'" :class="twMerge(customClass, props.justify && 'ml-auto')" />
  <Windows v-else :class="twMerge(customClass, props.justify && 'ml-auto')" />
</template>
