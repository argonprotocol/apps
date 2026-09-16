<template>
  <PopoverRoot :open="open" @update:open="onOpenUpdate">
    <PopoverAnchor asChild>
      <div
        v-bind="$attrs"
        role="button"
        tabindex="0"
        :aria-label="ariaLabel"
        :aria-expanded="open"
        :data-testid="triggerTestId"
        @pointerenter="openPreview"
        @pointerleave="queuePreviewClose"
        @focusin="openPreview"
        @focusout="queuePreviewClose"
        @click="emit('togglePin')"
        @keydown.enter.prevent="emit('togglePin')"
        @keydown.space.prevent="emit('togglePin')"
      >
        <slot />
      </div>
    </PopoverAnchor>

    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="center"
        :sideOffset="8"
        :collisionPadding="8"
        :style="floatingZIndex"
        class="max-h-[var(--reka-popover-content-available-height)] w-md max-w-[calc(100vw-3rem)] overflow-y-auto rounded-md border border-gray-800/20 bg-white text-left leading-5.5 text-gray-600 shadow-xl"
        :data-testid="contentTestId"
        @open-auto-focus.prevent
        @pointerenter="cancelPreviewClose"
        @pointerleave="queuePreviewClose"
        @focusin="cancelPreviewClose"
        @focusout="queuePreviewClose"
      >
        <slot name="content" />
        <PopoverPanelArrow class="-translate-y-px" :data-testid="arrowTestId" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';
import PopoverPanelArrow from '../../components/PopoverPanelArrow.vue';
import { useTopOverlayFloatingZIndex } from '../helpers/OverlayZIndex.ts';

defineOptions({
  inheritAttrs: false,
});

const props = defineProps<{
  open: boolean;
  pinned: boolean;
  ariaLabel: string;
  triggerTestId: string;
  contentTestId: string;
  arrowTestId: string;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'leave'): void;
  (event: 'togglePin'): void;
  (event: 'dismiss'): void;
}>();

let closeTimer: ReturnType<typeof setTimeout> | undefined;
const floatingZIndex = useTopOverlayFloatingZIndex();

Vue.onBeforeUnmount(cancelPreviewClose);

function openPreview() {
  cancelPreviewClose();
  if (!props.pinned) emit('preview');
}

function queuePreviewClose() {
  cancelPreviewClose();
  if (props.pinned) return;
  closeTimer = setTimeout(() => emit('leave'), 100);
}

function cancelPreviewClose() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = undefined;
}

function onOpenUpdate(isOpen: boolean) {
  if (!isOpen) emit('dismiss');
}
</script>
