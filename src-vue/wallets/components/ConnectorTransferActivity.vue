<template>
  <div aria-hidden="true" class="relative mx-2 h-6 w-40 shrink-0">
    <svg class="absolute top-1/2 -left-1 h-1 w-[calc(100%+10px)] -translate-y-1/2 text-neutral-400/80 shadow-sm/40">
      <line x1="0" x2="100%" y1="2" y2="2" stroke="currentColor" stroke-width="4" stroke-dasharray="8 4" />
    </svg>

    <div
      v-for="(direction, index) in props.transferDirections"
      :key="direction"
      class="pointer-events-none absolute inset-0"
      :class="activityWindowClass(index)"
    >
      <span
        class="transfer-particle absolute top-1/2 left-[-15px] z-10 size-3.5 rounded-full border border-black bg-gray-300 shadow-[0_0_9px_rgba(162,76,184,0.8)]"
        :class="[
          movesRight(direction) ? 'transfer-particle-right' : 'transfer-particle-left',
          activityDelayClass(index),
        ]"
      />
      <span
        class="wallet-endpoint-ripple border-argon-500/80 absolute top-1/2 size-5 -translate-y-1/2 rounded-full border"
        :class="[
          props.side === 'left' ? 'right-[-18px]' : 'left-[-18px]',
          direction === 'inbound' ? 'wallet-endpoint-arrival' : 'wallet-endpoint-source',
          activityDelayClass(index),
        ]"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ICrosschainTransferDirection } from './crosschainTransferView.ts';

const props = defineProps<{
  side: 'left' | 'right';
  transferDirections: ICrosschainTransferDirection[];
}>();

function movesRight(direction: ICrosschainTransferDirection) {
  return (props.side === 'left' && direction === 'inbound') || (props.side === 'right' && direction === 'outbound');
}

function activityWindowClass(index: number) {
  if (props.transferDirections.length < 2) return '';
  return index === 0 ? 'activity-window-first' : 'activity-window-second';
}

function activityDelayClass(index: number) {
  return props.transferDirections.length === 2 && index === 1 ? 'activity-delay-second' : '';
}
</script>

<style scoped>
.transfer-particle,
.wallet-endpoint-ripple {
  opacity: 0;
  animation-duration: 2.6s;
  animation-iteration-count: infinite;
  animation-timing-function: ease-in-out;
}

.transfer-particle-right {
  animation-name: transfer-particle-right;
}

.transfer-particle-left {
  animation-name: transfer-particle-left;
}

.wallet-endpoint-arrival {
  animation-name: wallet-endpoint-arrival;
}

.wallet-endpoint-source {
  animation-name: wallet-endpoint-source;
}

.activity-delay-second {
  animation-delay: 2.6s;
}

.activity-window-first,
.activity-window-second {
  animation-duration: 5.2s;
  animation-iteration-count: infinite;
  animation-timing-function: step-end;
}

.activity-window-first {
  animation-name: activity-window-first;
}

.activity-window-second {
  animation-name: activity-window-second;
}

@keyframes transfer-particle-right {
  0% {
    opacity: 0;
    transform: translate3d(0, -50%, 0) scale(0.35);
  }
  12% {
    opacity: 1;
    transform: translate3d(0, -50%, 0) scale(1);
  }
  70% {
    opacity: 1;
    transform: translate3d(176px, -50%, 0) scale(1);
  }
  82%,
  100% {
    opacity: 0;
    transform: translate3d(176px, -50%, 0) scale(0.25);
  }
}

@keyframes transfer-particle-left {
  0% {
    opacity: 0;
    transform: translate3d(176px, -50%, 0) scale(0.35);
  }
  12% {
    opacity: 1;
    transform: translate3d(176px, -50%, 0) scale(1);
  }
  70% {
    opacity: 1;
    transform: translate3d(0, -50%, 0) scale(1);
  }
  82%,
  100% {
    opacity: 0;
    transform: translate3d(0, -50%, 0) scale(0.25);
  }
}

@keyframes wallet-endpoint-arrival {
  0%,
  66%,
  88%,
  100% {
    opacity: 0;
    transform: translateY(-50%) scale(0.35);
  }
  76% {
    opacity: 0.9;
    transform: translateY(-50%) scale(1.25);
  }
}

@keyframes wallet-endpoint-source {
  0%,
  20%,
  100% {
    opacity: 0;
    transform: translateY(-50%) scale(0.35);
  }
  10% {
    opacity: 0.9;
    transform: translateY(-50%) scale(1.25);
  }
}

@keyframes activity-window-first {
  0%,
  49.99% {
    visibility: visible;
  }
  50%,
  100% {
    visibility: hidden;
  }
}

@keyframes activity-window-second {
  0%,
  49.99% {
    visibility: hidden;
  }
  50%,
  100% {
    visibility: visible;
  }
}
</style>
