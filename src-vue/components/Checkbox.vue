<!-- prettier-ignore -->
<template>
  <div :class="`relative min-w-${props.size} min-h-${props.size} w-${props.size} h-${props.size}`">
    <div
      v-if="props.isChecked"
      :style="`border-width: ${props.size/2}px`"
      :class="{ 'animate-pulse': props.isPulsing }"
      class="flex items-center justify-center w-full h-full border-argon-button bg-argon-button"
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

    <div
      v-else-if="props.isPartiallyChecked"
      :style="`border-width: ${props.size/2}px`"
      class="relative flex items-center justify-center w-full h-full border-argon-button"
    >
      <div
        class="absolute top-0 bottom-0 left-0 w-full bg-gradient-to-t from-argon-button-hover/40 to-argon-button-hover/10"
      />
      <svg
        class="relative pointer-events-none w-full h-full self-center justify-self-center stroke-white"
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

    <div v-else :style="`border-width: ${props.size/2}px`" class="w-full h-full border-slate-400" />
  </div>
</template>

<script setup lang="ts">
const props = defineProps({
  isChecked: {
    type: Boolean,
    default: false,
  },
  isPulsing: {
    type: Boolean,
    default: false,
  },
  isPartiallyChecked: {
    type: Boolean,
    default: false,
  },
  size: {
    type: Number,
    default: 8,
  },
});
</script>
