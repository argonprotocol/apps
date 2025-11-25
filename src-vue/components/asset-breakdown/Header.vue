<template>
  <TooltipRoot :openDelay="200" :closeDelay="100">
    <TooltipTrigger
      as="div"
      :class="
        twMerge('border-t border-gray-600/40', props.class, paddingClass, isRight ? 'flex-row-reverse' : 'flex-row')
      "
      :style="{ height }"
      class="Row Header">
      <div class="Icon">
        <slot name="icon" />
      </div>
      <div class="Text" :class="isRight ? 'text-right' : ''">
        <slot />
      </div>
      <div class="Value">
        <slot name="value" />
      </div>
    </TooltipTrigger>
    <TooltipContent
      align="start"
      :alignOffset="props.tooltip.length < 100 ? -10 : -20"
      :side="isRight ? 'left' : 'right'"
      :avoidCollisions="false"
      :class="props.tooltip.length < 100 ? 'w-fit' : 'w-md'"
      class="z-50 rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
      <div v-html="props.tooltip" />
      <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
    </TooltipContent>
  </TooltipRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { TooltipProvider, TooltipArrow, TooltipContent, TooltipRoot, TooltipTrigger } from 'reka-ui';

const props = withDefaults(
  defineProps<{
    tooltip: string;
    class?: string;
    height: number | 'auto';
    align?: 'left' | 'right';
  }>(),
  {
    align: 'left',
  },
);

const height = Vue.computed(() => (props.height === 'auto' ? 'auto' : `${props.height}%`));
const paddingClass = Vue.computed(() => (props.height === 'auto' ? 'py-2' : ''));
const isRight = Vue.computed(() => props.align === 'right');
</script>

<style scoped>
@reference "../../main.css";

.Row {
  @apply flex w-full items-center;
  &:hover {
    @apply text-argon-600 from-argon-200/0 via-argon-200/12 to-argon-200/0;
    background: linear-gradient(
      90deg,
      var(--tw-gradient-from) 0%,
      var(--tw-gradient-via) 10%,
      var(--tw-gradient-via) 90%,
      var(--tw-gradient-to) 100%
    );
    box-shadow: inset 0 -1px 0 0 rgba(255, 255, 255, 0.7);
  }
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
