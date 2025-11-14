<template>
  <div
    :class="twMerge(props.align === 'start' ? '' : 'translate-x-full', props.isSelected ? '' : 'text-slate-600/20')"
    class="aspect-square h-full overflow-hidden">
    <div
      :class="
        twMerge(
          props.align === 'start' ? '-left-1' : '-left-1',
          props.isSelected ? 'border-argon-600' : 'border-slate-600/20',
          props.isSelected && props.align === 'end' ? 'bg-slate-100' : 'bg-white',
        )
      "
      class="absolute top-1/2 aspect-square h-[150%] translate-x-[-75%] -translate-y-1/2 rounded-full border" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';

const props = withDefaults(
  defineProps<{
    align?: 'start' | 'end';
    isSelected?: boolean;
  }>(),
  {
    align: 'start',
    isSelected: false,
  },
);
</script>
