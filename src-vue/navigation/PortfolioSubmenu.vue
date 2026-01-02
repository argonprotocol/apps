<template>
  <DropdownMenuSub>
    <DropdownMenuSubTrigger class="relative py-2">
      <ChevronLeftIcon class="absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 text-gray-400" />
      <header>Portfolio Details</header>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent class="relative -top-1 min-w-50">
      <div
        class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
        <DropdownMenuItem class="py-2" @click="() => openPortfolioPanel(PortfolioTab.AssetBreakdown)">
          <header>Asset Breakdown</header>
        </DropdownMenuItem>
        <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
        <DropdownMenuItem class="py-2" @click="() => openPortfolioPanel(PortfolioTab.ProfitAnalysis)">
          <header>Profit Analysis</header>
        </DropdownMenuItem>
        <DropdownMenuSeparator divider class="my-1 h-[1px] w-full bg-slate-400/30" />
        <DropdownMenuItem class="py-2" @click="() => openPortfolioPanel(PortfolioTab.GrowthProjections)">
          <header>Growth Projections</header>
        </DropdownMenuItem>
        <DropdownMenuItem class="py-2" @click="() => openPortfolioPanel(PortfolioTab.TransactionHistory)">
          <header>Transaction History</header>
        </DropdownMenuItem>
      </div>
    </DropdownMenuSubContent>
  </DropdownMenuSub>
</template>
<script setup lang="ts">
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from 'reka-ui';
import basicEmitter from '../emitters/basicEmitter.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function openPortfolioPanel(tab: PortfolioTab) {
  basicEmitter.emit('openPortfolioPanel', tab);
  emit('close');
}
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-3 text-right focus:outline-none;
}
</style>
