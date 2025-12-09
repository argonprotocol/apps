<!-- prettier-ignore -->
<template>
  <div class="Arrow Component" :class="twMerge('relative w-[16px] h-[68px]', props.class ?? '')">
    <svg preserveAspectRatio="none" viewBox="0 0 6 12" class="w-full h-full">
      <path d="M0 2 L6 6 L0 10 Z" fill="white" />
    </svg>
    <svg preserveAspectRatio="none" class="absolute top-1/2 left-0 w-[70%] h-[65%] -translate-y-1/2" viewBox="0 0 6 12">
      <path d="M0 2 L6 6 L0 10 Z" fill="currentColor" />
    </svg>
  </div>
</template>

<script setup lang="ts">
import { twMerge } from 'tailwind-merge';

const props = defineProps<{
  class?: string | undefined;
}>();
</script>
