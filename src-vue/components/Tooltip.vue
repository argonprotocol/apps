<template>
  <TooltipProvider :disableHoverableContent="true" :disableClosingTrigger="true" :delayDuration="300">
    <TooltipRoot @update:open="handleOpen" :disableClosingTrigger="true" :disableHoverableContent="true">
      <TooltipTrigger :asChild="props.asChild || undefined" tooltip>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="props.side ?? 'bottom'"
          :sideOffset="-5"
          :avoidCollisions="true"
          :collisionPadding="30"
          :style="{ width: width, maxWidth: maxWidth }"
          class="data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade text-md pointer-events-none z-[10000] rounded-md border border-gray-800/20 bg-white px-4 py-3 text-left leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity] select-none"
        >
          {{ content }}
          <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/30 shadow-xl/50" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { TooltipRootEmits, TooltipRootProps } from 'reka-ui';
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  useForwardPropsEmits,
} from 'reka-ui';

const props = defineProps<
  TooltipRootProps & {
    content?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    asChild?: boolean;
    calculateWidth?: () => string | undefined;
  }
>();
const emits = defineEmits<TooltipRootEmits>();

const width = Vue.ref('fit-content');
const maxWidth = Vue.ref();

function handleOpen(isOpen: boolean) {
  if (!isOpen) return;
  const calculatedWidth = props.calculateWidth?.();
  if (calculatedWidth) {
    width.value = calculatedWidth;
    maxWidth.value = undefined;
  } else {
    width.value = 'fit-content';
    maxWidth.value = '400px';
  }
}

const forward = useForwardPropsEmits(props, emits);
</script>
