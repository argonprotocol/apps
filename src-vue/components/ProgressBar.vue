<!-- prettier-ignore -->
<template>
  <div class="Component ProgressBar relative" :hasError="props.hasError">
    <div Bar :style="{ width: `calc(${progress}% + 2px)` }" :data-progress="progress">
      <span v-if="hasError" class="error">ERROR</span>
      <span v-else :style="{ opacity: progress / 25 }">{{ progressLabel }}</span>
    </div>
    <span v-if="!hasError" :style="{ opacity: (50 - progress) / 90 }" class="absolute top-1/2 right-0 -translate-y-1/2 !text-black/30">{{ progressLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const props = defineProps<{
  progress: number;
  hasError?: boolean;
}>();

const progressLabel = Vue.computed(() => {
  if (props.progress < 99) {
    return `${props.progress.toFixed(1)}%`;
  } else if (props.progress < 99.99) {
    return `${props.progress.toFixed(2)}%`;
  } else if (props.progress < 100) {
    return '99.99%';
  } else {
    return '100%';
  }
});
</script>

<style>
@reference "../main.css";

.Component.ProgressBar {
  @apply relative h-8 w-full overflow-hidden rounded-xl border bg-[#F2EAF3];
  border-color: rgba(0, 0, 0, 0.15);
  box-shadow: inset 1px 1px 3px rgba(0, 0, 0, 0.15);
  div[Bar] {
    @apply flex items-center justify-end overflow-hidden rounded-l-xl border-r bg-white transition-[width] duration-[1.2s];
    border-color: rgba(0, 0, 0, 0.3);
    height: calc(100%);
    position: absolute;
    left: -1px;
    top: 0px;
    &:after {
      content: '';
      position: absolute;
      left: 0;
      top: 1px;
      bottom: 1px;
      width: 20px;
      max-width: 100%;
      background: linear-gradient(to right, white 10%, transparent 100%);
    }
  }
  &[hasError='true'] {
    div[Bar] {
      @apply bg-[#FAD1D8];
      opacity: 0.7;
      width: calc(100% + 1px) !important;
      box-shadow: inset 1px 1px 0 white !important;
      &:after {
        background: linear-gradient(to right, #fad1d8 10%, transparent 100%);
        left: 1px;
      }
    }
  }
  span {
    @apply pr-2 text-xs text-gray-500 transition-[opacity] duration-[1.2s];
  }
}
</style>
