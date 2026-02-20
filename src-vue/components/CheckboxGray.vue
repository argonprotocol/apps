<!-- prettier-ignore -->
<template>
  <div class="w-7 h-7 max-w-7 max-h-7">
    <div
      v-if="props.isChecked"
      class="flex items-center justify-center w-full h-full border-2 mr-4 border-transparent bg-gray-400/70"
    >
      <svg
        class="pointer-events-none size-10 self-center justify-self-center stroke-white"
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
    <div v-else class="w-full h-full border-2 border-gray-300 mr-4 rounded-full" />
  </div>
</template>

<script setup lang="ts">
const props = defineProps({
  isChecked: {
    type: Boolean,
    default: false,
  },
});
</script>
