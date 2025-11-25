<template>
  <HoverCardRoot :openDelay="200" :closeDelay="100">
    <HoverCardTrigger
      as="div"
      class="Row SubItem"
      :class="twMerge(props.class, isRight ? 'flex-row-reverse' : 'flex-row')"
      :style="{ height }">
      <div class="Connector" :isReversed="isRight" />
      <div class="Text" :class="[isRight ? 'flex-row-reverse' : 'flex-row', paddingClass]">
        <slot />
        <div
          v-if="props.showArrow"
          class="h-3 grow bg-gradient-to-r"
          :class="isRight ? 'mr-1 from-slate-600/20 to-slate-600/0' : 'ml-1 from-slate-600/0 to-slate-600/20'" />
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

const props = defineProps<{
  tooltip: string;
  class?: string;
  height: number | 'auto';
  align?: 'left' | 'right';
  showArrow?: boolean;
}>();

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

.SubItem {
  @apply flex;
  .Connector {
    @apply relative h-full w-9;
    &:before {
      content: '';
      @apply bg-argon-600/40 absolute top-0 left-1/2 h-1/2 w-px translate-x-[-6px];
    }
    &:after {
      content: '';
      @apply bg-argon-600/40 absolute top-1/2 left-1/2 h-px w-3.5 translate-x-[-6px];
    }
  }
  .Connector[isReversed='true'] {
    &:before {
      @apply left-1/2 translate-x-[3px];
    }
    &:after {
      @apply right-1/2 left-0 translate-x-[8px];
    }
  }
  .Text {
    @apply flex h-full grow items-center border-t border-dashed border-gray-600/20 text-slate-900/60;
  }
}
</style>
