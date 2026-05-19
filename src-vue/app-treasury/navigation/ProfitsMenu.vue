<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-md border border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
          <div class="ml-[3px] relative top-px -mr-0.5">
            {{ numeral(financials.totalPerformanceReturn).format('0,0.[00]') }}% RTD
          </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="absolute top-0 left-0 text-slate-700/50 w-full sm:w-auto px-4 py-1 data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight"
      >
        <div class="grid min-w-[500px] grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] gap-x-10 whitespace-nowrap border-b border-slate-400/30 px-9 py-3 text-center">
          <div class="pt-3 pb-2">
            <div class="text-3xl font-bold text-argon-700/80">{{ numeral(financials.savingsAllTimeReturn).format('0,0.[00]') }}%</div>
            <div>Savings vs {{ financials.savingsAllTimeFiatKey }}</div>
          </div>
          <div class="bg-slate-500/50" />
          <div class="pt-3 pb-2">
            <div class="text-3xl font-bold text-argon-700/80">{{ numeral(financials.liquidPerformanceReturn).format('0,0.[00]') }}%</div>
            <div>Bitcoin Locks</div>
          </div>
        </div>
        <div class="grid min-w-[500px] grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] gap-x-10 whitespace-nowrap border-b border-slate-400/30 px-9 py-3 text-center">
          <div class="pt-3 pb-2">
            <div class="text-3xl font-bold text-argon-700/80">{{ numeral(financials.bondsPerformanceReturn).format('0,0.[00]') }}%</div>
            <div>Argon Bonds</div>
          </div>
          <div class="bg-slate-500/50" />
          <div class="pt-3 pb-2">
            <div class="text-3xl font-bold text-argon-700/80">{{ numeral(financials.swapsPerformanceReturn).format('0,0.[00]') }}%</div>
            <div>Stable Swaps</div>
          </div>
        </div>
        <button class="border border-argon-600/50 text-argon-600/80 py-2 px-3 rounded-md w-full my-3 cursor-pointer whitespace-nowrap hover:bg-argon-600/70 hover:text-white">
          View Portfolio Profits
        </button>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent } from 'reka-ui';
import { useFinancials } from '../stores/financials.ts';
import numeral from '../../lib/numeral.ts';

const financials = useFinancials();

const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover/80 cursor-pointer pr-3 text-right focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  [ItemWrapper] {
    @apply font-bold whitespace-nowrap text-gray-900;
  }
}
</style>
