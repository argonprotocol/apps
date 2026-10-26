<template>
  <NavigationMenuItem value="return-metric" class="pointer-events-auto">
    <NavigationMenuTrigger
      aria-label="Return metric"
      class="text-argon-600/70 flex h-[30px] cursor-pointer items-center rounded-r-md border border-l-0 border-slate-400/50 px-1.5 hover:bg-slate-400/10 focus:outline-none data-[state=open]:bg-slate-400/10"
    >
      <ChevronDownIcon class="w-4" />
    </NavigationMenuTrigger>
    <NavigationMenuContent class="absolute top-0 left-0 w-full sm:w-auto">
      <div class="bg-argon-menu-bg flex flex-col rounded p-1 text-sm font-semibold text-gray-900">
        <NavigationMenuLink
          v-for="metric in ['RTD', 'APR', 'APY'] as const"
          :key="metric"
          :class="config.returnMetric === metric ? 'text-argon-500' : 'text-slate-700'"
          class="hover:bg-argon-menu-hover flex cursor-pointer items-center justify-end gap-2 border-b border-slate-400/30 px-3 py-3 last:border-b-0"
          @click="config.returnMetric = metric"
        >
          <CheckIcon v-if="config.returnMetric === metric" class="h-5" />
          {{ metric }}
        </NavigationMenuLink>
      </div>
    </NavigationMenuContent>
  </NavigationMenuItem>
</template>

<script setup lang="ts">
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuTrigger } from 'reka-ui';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getConfig } from '../stores/config.ts';

const config = getConfig();
</script>
