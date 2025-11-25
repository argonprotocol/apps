<template>
  <HoverCardRoot :openDelay="200" :closeDelay="100">
    <HoverCardTrigger
      as="div"
      :class="
        twMerge('border-t border-gray-600/40', props.class, paddingClass, isRight ? 'flex-row-reverse' : 'flex-row')
      "
      :style="{ height }"
      class="Row Expenses">
      <div class="Text grow" :class="[isRight ? 'text-right' : 'text-left']">
        <slot />
      </div>
      <div class="Value relative" :class="[isRight ? '-left-1' : '']">
        <slot name="value" />
      </div>
    </HoverCardTrigger>
    <HoverCardContent
      align="start"
      :alignOffset="-20"
      :side="isRight ? 'left' : 'right'"
      :avoidCollisions="false"
      class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
      <div v-html="props.tooltip" />
      <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
    </HoverCardContent>
  </HoverCardRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';

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
    @apply from-argon-200/0 via-argon-200/12 to-argon-200/0 text-red-600;
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

.Expenses {
  @apply text-red-600/60; /* border-t border-dashed border-gray-600/20; */
}
</style>
