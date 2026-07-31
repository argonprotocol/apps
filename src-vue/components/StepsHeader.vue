<template>
  <TooltipProvider :disableHoverableContent="true">
    <div class="mr-6 flex w-full flex-col gap-1">
      <div class="flex w-full flex-row items-center">
        <template v-for="(item, index) of items" :key="index">
          <TooltipRoot v-if="item.label" :delayDuration="100" :disabled="props.isLoading">
            <TooltipTrigger
              tabindex="-1"
              class="flex w-[calc(33.333333%+3rem)] flex-row items-center"
              :class="item.click && !props.isLoading ? 'cursor-pointer' : ''"
              @click="props.isLoading ? undefined : item.click?.()"
            >
              <component
                v-if="index === 0"
                :is="icon"
                :class="isActive(item) ? 'text-argon-600/80' : 'text-black/20'"
                class="relative left-1 mr-2 h-10"
              />
              <div
                :class="
                  isActive(item)
                    ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                    : 'border-slate-600/20 bg-white text-black/20'
                "
                class="relative grow border-y px-1 py-1 text-center text-base font-bold whitespace-nowrap"
              >
                {{ item.label }}
                <RoundCap class="absolute top-0 left-0" :isSelected="isActive(item)" />
                <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="isActive(item)" />
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              :sideOffset="-10"
              :align="index < items.length - 1 ? 'start' : 'end'"
              :collisionPadding="9"
              class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-left leading-5.5 font-light text-slate-900/60 shadow-2xl"
            >
              {{ item.tooltip }}
              <TooltipArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
            </TooltipContent>
          </TooltipRoot>

          <TooltipRoot v-else :delayDuration="100">
            <TooltipTrigger asChild tabindex="-1">
              <Arrows
                :class="isActive(item) ? 'text-argon-600/80 processing-active' : 'text-black/10'"
                class="ml-5 min-h-[34px] pr-1.5"
              />
            </TooltipTrigger>
            <TooltipContent
              :sideOffset="-7"
              :collisionPadding="9"
              side="bottom"
              align="center"
              class="text-md z-50 w-sm rounded-md border border-gray-800/20 bg-white px-5 py-4 text-center leading-5.5 font-light text-slate-900/60 shadow-2xl"
            >
              {{ item.tooltip }}
              <TooltipArrow :width="27" :height="15" class="-mt-px ml-4 fill-white stroke-gray-800/20 stroke-[0.5px]" />
            </TooltipContent>
          </TooltipRoot>
        </template>
      </div>
    </div>
  </TooltipProvider>
</template>

<script lang="ts">
export interface IStepHeaderItem {
  label: string;
  tooltip: string;
  isActive: () => boolean;
  click?: () => void;
}
</script>

<script setup lang="ts">
import type { Component } from 'vue';
import RoundCap from '../overlays/bitcoin-locking/components/RoundCap.vue';
import Arrows from '../assets/arrows.svg?component';
import { TooltipArrow, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';

const props = defineProps<{
  icon: Component;
  items: IStepHeaderItem[];
  isLoading: boolean;
  hasError: boolean;
}>();

function isActive(item: IStepHeaderItem) {
  if (props.isLoading || props.hasError) return false;
  return item.isActive();
}
</script>
