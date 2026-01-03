<!-- prettier-ignore -->
<template>
  <TooltipRoot :openDelay="200" :closeDelay="100">
    <TooltipTrigger
      as="div"
      :class="
        twMerge('border-t border-gray-600/40', props.class, paddingClass, 'flex-row')
      "
      :style="{ height }"
      class="Row Total"
    >
      <div class="Text grow text-left">
        <slot />
      </div>
      <div class="Value">
        <slot name="value" />
      </div>
      <div v-if="spacerWidth" :style="{ width: spacerWidth }" />
    </TooltipTrigger>
    <TooltipContent
      align="start"
      :alignOffset="tooltipSide === 'right' ? (isShortText ? -10 : -20) : 0"
      :side="tooltipSide"
      :sideOffset="tooltipSide === 'right' ? 0 : 4"
      :avoidCollisions="false"
      :class="tooltipSide === 'right' && (isShortText ? 'w-fit' : 'w-md')"
      class="z-50 rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl pointer-events-none">
      <slot name="tooltip" />
      <TooltipArrow v-if="tooltipSide === 'right'" :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
      <div v-else class="absolute top-full pointer-events-none left-12">
        <CustomTooltipArrow />
      </div>
    </TooltipContent>
  </TooltipRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { TooltipArrow, TooltipContent, TooltipRoot, TooltipTrigger } from 'reka-ui';
import CustomTooltipArrow from './TooltipArrow.vue';

const props = withDefaults(
  defineProps<{
    class?: string;
    height: number | 'auto';
    spacerWidth?: string;
    tooltipSide?: 'right' | 'top';
  }>(),
  {},
);
const slots = Vue.useSlots();

const height = Vue.computed(() => (props.height === 'auto' ? 'auto' : `${props.height}%`));
const paddingClass = Vue.computed(() => (props.height === 'auto' ? 'py-2' : ''));
const isShortText = (slots.tooltip?.() ?? []).length < 120;
</script>

<style scoped>
@reference "../../main.css";

.Row {
  @apply flex w-full items-center;
}

.Total {
  @apply font-bold; /* border-t border-dashed border-gray-600/20; */
}
</style>
