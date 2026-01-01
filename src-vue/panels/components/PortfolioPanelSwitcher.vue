<template>
  <DropdownMenuRoot class="relative inline-block">
    <DropdownMenuTrigger
      :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-transparent']"
      class="-ml-1.5 inline-flex flex-row items-center rounded border px-1.5 hover:border-slate-400/50">
      <template v-if="selectedTab === PortfolioTab.AssetBreakdown">Asset Breakdown</template>
      <template v-if="selectedTab === PortfolioTab.ProfitAnalysis">Profit Analysis</template>
      <template v-if="selectedTab === PortfolioTab.GrowthProjections">Growth Projections</template>
      <template v-if="selectedTab === PortfolioTab.TransactionHistory">Transaction History</template>
      <ChevronDownIcon class="ml-1 h-5 w-5" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :align="'start'"
        :alignOffset="0"
        :sideOffset="-3"
        class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
        <div
          class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-2xl font-bold text-slate-800/70 shadow-lg ring-1 ring-gray-900/20">
          <DropdownMenuItem class="pt-1 pb-2" @select="selectItem(PortfolioTab.AssetBreakdown, $event)">
            <header>Asset Breakdown</header>
          </DropdownMenuItem>
          <DropdownMenuItem class="pt-1 pb-2" @select="selectItem(PortfolioTab.ProfitAnalysis, $event)">
            <header>Profit Analysis</header>
          </DropdownMenuItem>
          <DropdownMenuItem class="pt-1 pb-2" @select="selectItem(PortfolioTab.GrowthProjections, $event)">
            <header>Growth Projections</header>
          </DropdownMenuItem>
          <DropdownMenuItem class="pt-1 pb-2" @select="selectItem(PortfolioTab.TransactionHistory, $event)">
            <header>Transaction History</header>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/vue/24/outline';
import { PortfolioTab } from '../interfaces/IPortfolioTab.ts';

const props = defineProps<{
  tab: PortfolioTab;
}>();

const emit = defineEmits<{
  (e: 'change', tab: PortfolioTab): void;
}>();

const selectedTab = Vue.ref(props.tab);
const isOpen = Vue.ref(false);

function selectItem(tab: PortfolioTab, $event: any) {
  selectedTab.value = tab;
  emit('change', tab);
}

Vue.watch(
  () => props.tab,
  () => {
    selectedTab.value = props.tab;
  },
);
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-4 focus:outline-none;
}
</style>
