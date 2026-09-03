<template>
  <TooltipProvider :disableHoverableContent="true">
    <div class="mr-6 flex w-full flex-col gap-1">
      <div class="flex w-full flex-row items-center">
        <template v-for="(item, index) of items" :key="index">
          <TooltipRoot v-if="item.label" :delayDuration="100" :disabled="props.isLoading">
            <TooltipTrigger
              tabindex="-1"
              class="flex min-w-0 flex-1 flex-row items-center"
              :class="item.click && !props.isLoading ? 'cursor-pointer' : ''"
              @click="props.isLoading ? undefined : item.click?.()"
            >
              <component
                v-if="index === 0"
                :is="icon"
                :class="isActive(item) ? 'text-argon-600/80' : 'text-black/20'"
                class="relative left-1 mr-2 h-10 shrink-0"
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
                <ExclamationTriangleIcon
                  v-if="item.hasWarning"
                  class="ml-1 inline h-4 w-4 align-text-bottom text-amber-500"
                />
                <RoundCap class="absolute top-0 left-0" :isSelected="isActive(item)" />
                <RoundCap align="end" class="absolute top-0 right-[2px]" :isSelected="isActive(item)" />
                <div
                  v-if="item.value && !isActive(item) && !props.isLoading"
                  class="text-argon-600/50 absolute bottom-full left-1/2 min-w-[60%] -translate-x-1/2 translate-y-2 rounded-md border border-gray-600/30 bg-white px-2 py-1 text-xs font-bold"
                >
                  {{ item.value }}
                </div>
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
                class="h-9 w-10 shrink-0"
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
  value?: string;
  tooltip: string;
  isActive: () => boolean;
  click?: () => void;
  hasWarning?: boolean;
}
</script>

<script setup lang="ts">
import type { Component } from 'vue';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
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
