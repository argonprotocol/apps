<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">

    <div>
      <NavigationMenuItem class="pointer-events-auto">
        <NavigationMenuTrigger
          Trigger
          class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-l-md border border-r-0 border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
        >
          <ArgonSign v-if="!currency?.record?.key || currency?.record?.key === 'ARGN'" class="h-[13px] relative top-0" />
          <DollarSign v-else-if="currency?.record?.key === 'USD'" class="h-[15px]" />
          <EuroSign v-else-if="currency?.record?.key === 'EUR'" class="h-[15px]" />
          <PoundSign v-else-if="currency?.record?.key === 'GBP'" class="h-[15px]" />
          <RupeeSign v-else-if="currency?.record?.key === 'INR'" class="h-[15px]" />
          <div v-else class="h-[18px] w-[13px]"></div>
          <div class="ml-[3px] relative top-px -mr-0.5">
            {{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
          </div>
        </NavigationMenuTrigger>

        <NavigationMenuContent class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto">
          <div class="bg-argon-menu-bg flex shrink flex-col rounded py-1 px-2 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <div class="relative min-w-88 aspect-square px-2 flex flex-col pointer-events-none mb-14">
              <div class="mx-auto grid w-fit grid-cols-[max-content_max-content] items-center gap-x-6 gap-y-2 whitespace-nowrap pt-5 pb-7 font-light text-slate-800/70">
                <div class="flex flex-row items-center">
                  <span class="w-4 h-4 inline-block bg-[#9FE1CB] mr-1.5" />
                  Inflation-Free Savings
                </div>
                <div class="flex flex-row items-center">
                  <span class="w-4 h-4 inline-block bg-[#FAC775] mr-1.5" />
                  Bitcoin Locks
                </div>
                <div class="flex flex-row items-center">
                  <span class="w-4 h-4 inline-block bg-[#CFCBF6] mr-1.5" />
                  Argon Bonds
                </div>
                <div class="flex flex-row items-center">
                  <span class="w-4 h-4 inline-block bg-[#D3D1C7] mr-1.5" />
                  Stable Swaps
                </div>
              </div>
              <div class="grow relative">
                <OverviewPie :strokeWidth="5" :borderWidth="5" />
              </div>
            </div>
            <NavigationMenuLink class="pb-2.5! px-2! focus:bg-transparent! cursor-default! flex flex-row gap-x-2">
              <button @click="openPortfolioPanel" class="border border-argon-600/50 text-argon-600/80 py-2 px-3 rounded-md w-full cursor-pointer whitespace-nowrap hover:bg-argon-600/70 hover:text-white">
                Open Portfolio Overview
              </button>
              <button @click="openPortfolioPanel" class="border border-argon-600/50 text-argon-600/80 py-2 px-3 rounded-md w-full cursor-pointer whitespace-nowrap hover:bg-argon-600/70 hover:text-white">
                View Transaction History
              </button>
            </NavigationMenuLink>
          </div>
        </NavigationMenuContent>
      </NavigationMenuItem>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink } from 'reka-ui';
import { getCurrency } from '../stores/currency.ts';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import { useWallets } from '../stores/wallets.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { ICurrencyKey, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getConfig } from '../stores/config.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import { IS_TREASURY_APP, IS_OPERATIONS_APP } from '../lib/Env.ts';
import { useFinancials } from '../stores/financials.ts';
import OverviewPie from '../panels/portfolio/OverviewPie.vue';

const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const currency = getCurrency();
const financials = useFinancials();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const totalNetWorth = Vue.computed(() => {
  if (!currency.isLoaded) {
    return ['--', '--'];
  }
  const rawValue = financials.totalValue;
  const value = microgonToMoneyNm(rawValue).format('0,0.00');
  return value.split('.');
});

function openPortfolioPanel(): void {
  basicEmitter.emit('openPortfolioPanel', PortfolioTab.Overview);
}

function openTransactionsOverlay() {
  basicEmitter.emit('openTransactionsOverlay');
}
</script>

<style scoped>
@reference "../main.css";

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
