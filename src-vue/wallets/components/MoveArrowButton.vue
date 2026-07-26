<template>
  <div
    class="absolute top-1/2 z-40 -translate-x-1/2 -translate-y-1/2"
    :class="props.placement === 'left' ? '-left-1' : 'left-[calc(100%+4px)]'"
  >
    <div class="absolute top-1 left-0 z-10 h-[calc(100%-8px)] w-[15%] bg-linear-to-r from-white to-transparent" />
    <div class="relative h-[45.6px]">
      <button
        :data-testid="props.testId"
        type="button"
        :disabled="props.disabled"
        :aria-disabled="props.disabled"
        :title="props.title"
        class="h-full"
        :class="props.disabled ? 'cursor-default' : 'cursor-pointer'"
        @click="emit('click', $event)"
      >
        <div v-if="props.pending" spinner class="absolute inset-y-0 right-4 z-20 my-auto h-5 w-5 border-3" />
        <div
          v-else
          class="absolute inset-0 flex items-center justify-center text-sm font-bold"
          :class="props.disabled ? 'text-slate-500 opacity-30' : 'text-argon-600'"
        >
          <span class="relative right-1.5 z-20">{{ WALLET_MOVE_LABEL }}</span>
        </div>
        <MoveArrow class="pointer-events-none h-full" />
      </button>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useForwardExpose } from 'reka-ui';
import MoveArrow from '../../assets/move-arrow.svg';
import { WALLET_MOVE_LABEL } from '../walletOverlayState.ts';

useForwardExpose();

const props = defineProps<{
  disabled: boolean;
  pending?: boolean;
  placement?: 'left' | 'right';
  title?: string;
  testId?: string;
}>();

const emit = defineEmits<{
  (event: 'click', mouseEvent: MouseEvent): void;
}>();
</script>

<style scoped>
[spinner] {
  border-radius: 50%;
  display: block;
  border-style: solid;
  border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
  animation: rotation 1s linear infinite;
}

@keyframes rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
