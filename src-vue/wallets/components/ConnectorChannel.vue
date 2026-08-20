<template>
  <PopoverRoot :open="props.open" :modal="true" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        :align="props.direction === 'left' ? 'end' : 'start'"
        :sideOffset="-20"
        :collisionPadding="30"
        :style="floatingZIndex"
        class="w-96 rounded-lg border border-gray-800/20 bg-white text-left text-gray-700 shadow-2xl"
        @pointerDownOutside="keepOpenForRelatedConnector"
      >
        <header class="border-b border-slate-300 px-5 py-4 text-xl font-bold text-slate-800/70">Bitcoin Channel</header>
        <div class="min-h-48 px-5 py-4" />
        <PopoverArrow :width="26" :height="12" class="-mt-px fill-white stroke-gray-800/40 stroke-[0.5]" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  type PointerDownOutsideEvent,
} from 'reka-ui';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const props = defineProps<{
  connectorId?: string;
  direction: 'right' | 'left';
  open: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
}>();

const floatingZIndex = useFloatingZIndex();

function keepOpenForRelatedConnector(event: PointerDownOutsideEvent) {
  const target = event.detail.originalEvent.target;
  if (!(target instanceof Element)) return;

  const connectorId = target.closest('[data-wallet-connector-id]')?.getAttribute('data-wallet-connector-id');
  if (connectorId && connectorId === props.connectorId) event.preventDefault();
}
</script>
