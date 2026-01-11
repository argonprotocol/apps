<!-- prettier-ignore -->
<template>
  <TooltipRoot :openDelay="200" :closeDelay="100" :disabled="moveIsOpen" @update:open="updateOpen">
    <TooltipTrigger
      as="div"
      class="Row SubItem Component flex flex-row"
      :class="[{ShowMoveButton : showMoveButton, IsOpen: moveIsOpen }, twMerge(props.class)]"
      :style="{ height }"
    >
      <div class="SubItemWrapper flex w-full h-full items-center group">
        <div class="Connector" v-if="!props.hideConnector" />
        <div class="Text relative group pointer-events-none flex-row" :class="[paddingClass]">
          <slot />
          <div
            :class="moveIsOpen ? '' : 'opacity-0 group-hover:opacity-100'"
            class="transition-opacity duration-300 absolute top-1/2 right-0 -translate-y-1/2 bg-white rounded"
          >
            <MoveCapitalButton
              @updatedOpen="updateMoveOpen"
              :moveFrom="moveFrom"
              :moveToken="moveToken"
              :class="moveIsOpen ? 'bg-slate-300/20 inset-shadow-sm inset-shadow-slate-300/60' : ''"
              class="pointer-events-auto"
              side="right"
            />
          </div>
        </div>
      </div>
    </TooltipTrigger>
    <TooltipContent
      ref="contentRef"
      align="start"
      :alignOffset="tooltipSide === 'right' ? (isShortText ? -10 : -20) : 1"
      :side="tooltipSide"
      :sideOffset="tooltipSide === 'right' ? 0 : 8"
      :avoidCollisions="false"
      :class="tooltipSide === 'right' && (isShortText ? 'w-fit max-w-md' : 'w-md')"
      class="pointer-events-none z-50 rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl"
    >
      <slot name="tooltip" />
      <TooltipArrow v-if="tooltipSide === 'right'" :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
      <div v-else class="pointer-events-none absolute top-full 'left-12">
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
import MoveCapitalButton from '../../overlays/MoveCapitalButton.vue';
import { MoveFrom, MoveToken } from '@argonprotocol/apps-core';

const props = withDefaults(
  defineProps<{
    class?: string;
    height: number | 'auto';
    tooltipSide?: 'right' | 'top';
    moveFrom?: MoveFrom;
    moveToken?: MoveToken;
    hideConnector?: boolean;
  }>(),
  {},
);

const contentRef = Vue.ref();
const showMoveButton = Vue.ref(!!props.moveFrom);
const height = Vue.computed(() => (props.height === 'auto' ? 'auto' : `${props.height}%`));
const paddingClass = Vue.computed(() => (props.height === 'auto' ? 'py-2' : ''));
const moveIsOpen = Vue.ref(false);
const isShortText = Vue.ref(false);

function updateMoveOpen(isOpen: boolean) {
  moveIsOpen.value = isOpen;
}

let timeoutId: any = undefined;
function updateOpen(isOpen: boolean) {
  if (!isOpen) return;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = undefined;
  }
  timeoutId = setTimeout(() => {
    if (!contentRef.value) return;
    const elem: HTMLElement = contentRef.value.$el;
    const height = elem.getBoundingClientRect()?.height;
    isShortText.value = height < 100;
  }, 1);
}
</script>

<style scoped>
@reference "../../main.css";

.Row {
  @apply flex w-full items-center;
  &.IsOpen {
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

.SubItemWrapper {
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
  .Text {
    @apply flex h-full grow items-center border-t border-dashed border-gray-600/20 text-slate-900/60;
  }
}
</style>
