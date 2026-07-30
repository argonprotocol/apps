<template>
  <TooltipProvider :disableHoverableContent="true">
    <div class="mr-6 flex w-full flex-col gap-1">
      <div class="flex w-full flex-row items-center">
        <template v-for="(item, index) of items" :key="index">
          <TooltipRoot v-if="item.label" :delayDuration="100">
            <TooltipTrigger tabindex="-1" class="flex w-[calc(33.333333%+3rem)] flex-row items-center">
              <component
                v-if="index === 0"
                :is="icon"
                :class="item.isActive() ? 'text-argon-600/80' : 'text-black/20'"
                class="relative left-1 mr-2 h-10"
              />
              <div
                :class="
                  item.isActive()
                    ? 'text-argon-600 border-argon-600 bg-slate-400/10'
                    : 'border-slate-600/20 bg-white text-black/20'
                "
                class="relative grow border-y px-1 py-1 text-center text-base font-bold whitespace-nowrap"
              >
                {{ item.label }}
                <RoundCap class="absolute top-0 left-0" :isSelected="item.isActive()" />
                <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="item.isActive()" />
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              :sideOffset="-10"
              align="start"
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
                :class="item.isActive() ? 'text-argon-600/80 processing-active' : 'text-black/10'"
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
}
</script>

<script setup lang="ts">
import type { Component } from 'vue';
import RoundCap from '../overlays/bitcoin-locking/components/RoundCap.vue';
import Arrows from '../assets/arrows.svg?component';
import { TooltipArrow, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';

defineProps<{
  icon: Component;
  items: IStepHeaderItem[];
}>();
</script>
