<!-- prettier-ignore -->
<template>
  <div class="flex w-full flex-col justify-center  items-center h-full NeedsSetup  my-3" :class="isRight ? 'is-right  pr-10 ' : 'is-left pl-10'">
    <div class="whitespace-normal mb-5">
      <div class="Text italic text-slate-500" :class="isRight ? 'pl-[25%] text-right' : 'pr-[25%]'">
        <slot />
      </div>
    </div>
    <slot name="value" />
    <div class=" border-t border-dashed border-gray-600/20">
      &nbsp;
    </div>
    <div v-if="spacerWidth" :style="{ width: spacerWidth }" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { TooltipContent, TooltipRoot, TooltipTrigger, TooltipArrow } from 'reka-ui';
import CustomTooltipArrow from './TooltipArrow.vue';

const props = withDefaults(
  defineProps<{
    class?: string;
    align?: 'left' | 'right';
    spacerWidth?: string;
  }>(),
  {
    align: 'left',
  },
);

const isRight = Vue.computed(() => props.align === 'right');
</script>

<style scoped>
@reference "../../main.css";

.NeedsSetup {
  @apply from-slate-600/13 to-slate-600/0;
  &.is-right {
    background: linear-gradient(-90deg, var(--tw-gradient-from) 0%, var(--tw-gradient-to) 100%);
  }
  &.is-left {
    background: linear-gradient(90deg, var(--tw-gradient-from) 0%, var(--tw-gradient-to) 100%);
  }
}
</style>
