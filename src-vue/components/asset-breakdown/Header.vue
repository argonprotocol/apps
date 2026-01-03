<!-- prettier-ignore -->
<template>
  <TooltipRoot :openDelay="200" :closeDelay="100">
    <TooltipTrigger
      as="div"
      :class="
        twMerge('border-t border-gray-600/40 flex-row', props.class, paddingClass)
      "
      :style="{ height }"
      class="Row Header">
      <div class="Icon">
        <slot name="icon" />
      </div>
      <div class="Text">
        <slot />
      </div>
      <div class="Value">
        <slot name="value" />
      </div>
      <div v-if="spacerWidth" :style="{ width: spacerWidth }" />
    </TooltipTrigger>
    <TooltipContent
      align="start"
      :alignOffset="tooltipSide === 'right' ? -20 : -3"
      :side="tooltipSide"
      :sideOffset="tooltipSide === 'right' ? 0 : 4"
      :avoidCollisions="false"
      class="z-50 rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl w-md">
      <slot name="tooltip" />
      <TooltipArrow v-if="tooltipSide === 'right'" :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
      <div v-else class="absolute top-full pointer-events-none -mt-px left-12">
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

const height = Vue.computed(() => (props.height === 'auto' ? 'auto' : `${props.height}%`));
const paddingClass = Vue.computed(() => (props.height === 'auto' ? 'py-2' : ''));
</script>

<style scoped>
@reference "../../main.css";

.Row {
  @apply flex w-full items-center;
}

.Header {
  .Icon {
    @apply text-argon-600/70;
  }
  .Text {
    @apply grow px-2;
  }
  .Value {
    @apply pr-1;
  }
}
</style>
