<!-- prettier-ignore -->
<template>
  <div class="relative" :style="sizeStyle">
    <div
      v-if="props.isChecked"
      :style="`border-width: ${props.size/2}px`"
      class="flex items-center justify-center w-full h-full mr-4 border-transparent bg-gray-400/70"
    >
      <svg
        class="pointer-events-none w-full h-full self-center justify-self-center stroke-white"
        viewBox="0 0 14 14"
        fill="none"
      >
        <path
          class="opacity-100"
          d="M3 8L6 11L11 3.5"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>
    <div v-else :style="`border-width: ${props.size/2}px`" class="w-full h-full border-gray-300 mr-4 rounded-full" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps({
  isChecked: {
    type: Boolean,
    default: false,
  },
  size: {
    type: Number,
    default: 7,
  },
});

const sizeStyle = computed(() => {
  const size = `${props.size / 4}rem`;

  return {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
  };
});
</script>
