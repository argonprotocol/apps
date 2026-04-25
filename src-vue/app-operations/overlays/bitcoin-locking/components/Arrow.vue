<template>
  <svg
    :class="props.class"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    preserveAspectRatio="none">
    <path
      d="M0 0L16 8L0 16"
      stroke="currentColor"
      stroke-width="1"
      vector-effect="non-scaling-stroke"
      stroke-linecap="round"
      stroke-linejoin="round" />
  </svg>
</template>

<script setup lang="ts">
const props = defineProps<{
  class?: string | undefined;
}>();
</script>
