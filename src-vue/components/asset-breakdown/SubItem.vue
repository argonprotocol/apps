<!-- prettier-ignore -->
<template>
  <TooltipRoot :openDelay="200" :closeDelay="100">
    <TooltipTrigger
      as="div"
      class="Row SubItem Component"
      :class="twMerge(props.class, isRight ? 'flex-row-reverse' : 'flex-row')"
      :style="{ height }"
    >
      <div class="Connector" :isReversed="isRight" />
      <div class="Text relative group pointer-events-none" :class="[isRight ? 'flex-row-reverse' : 'flex-row', paddingClass]">
        <slot />
        <div
          v-if="props.showMoveButton"
          class="relative flex grow items-center"
          :class="isRight ? 'flex-row-reverse mr-2' : 'flex-row ml-2'"
        >
          <div
            :class="isRight ? 'bg-gradient-to-l' : 'bg-gradient-to-r'"
            class="pointer-events-auto h-3 grow from-slate-600/0 from-0% via-slate-600/13 via-20% to-slate-600/13 group-hover:via-slate-600/30 group-hover:to-slate-600/30"
          />
          <div
            :class="isRight ? 'pr-1.5 pl-[5px] -ml-1.5' : 'pl-1.5 pr-[5px] -mr-1.5'"
            class="relative pointer-events-auto"
          >
            <MoveCapitalButton
              :moveFrom="moveFrom"
              :moveTo="moveTo"
              class="opacity-50 transition-opacity duration-100 hover:opacity-100 bg-white"
            />
          </div>
        </div>
        <div
          v-if="props.showMoveButton"
          :class="isRight ? 'right-[calc(100%+7px)]' : 'left-[calc(100%+7px)]'"
          class="absolute pointer-events-auto w-[6.5%] h-3 grow bg-slate-600/13 group-hover:bg-slate-600/30"
        >
          <LineArrow
            :class="isRight ? 'rotate-180 right-full ' : 'left-full '"
            class="absolute top-1/2 -translate-y-1/2 text-slate-600/13 group-hover:text-slate-600/30"
          />
        </div>
      </div>
    </TooltipTrigger>
    <TooltipContent
      align="start"
      :alignOffset="tooltipSide === 'right' ? -20 : 1"
      :side="tooltipSide"
      :sideOffset="tooltipSide === 'right' ? 0 : 8"
      :avoidCollisions="false"
      class="pointer-events-none z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl"
    >
      <div v-html="props.tooltip" class="pointer-events-none" />
      <TooltipArrow v-if="tooltipSide === 'right'" :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
      <div v-else :class="isRight ? 'right-12' : 'left-12'" class="pointer-events-none absolute top-full">
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
import LineArrow from './LineArrow.vue';
import MoveCapitalButton, { MoveFrom, MoveTo } from '../../overlays/MoveCapitalButton.vue';

const props = withDefaults(
  defineProps<{
    tooltip: string;
    class?: string;
    height: number | 'auto';
    align?: 'left' | 'right';
    showMoveButton?: boolean;
    tooltipSide?: 'right' | 'top';
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
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
