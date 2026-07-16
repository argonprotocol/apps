<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-l-md border border-r-0 border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
        <ArgonSign v-if="!currency?.record?.key || currency?.record?.key === 'ARGN'" class="relative top-0 h-[13px]" />
        <DollarSign v-else-if="currency?.record?.key === 'USD'" class="h-[15px]" />
        <EuroSign v-else-if="currency?.record?.key === 'EUR'" class="h-[15px]" />
        <PoundSign v-else-if="currency?.record?.key === 'GBP'" class="h-[15px]" />
        <RupeeSign v-else-if="currency?.record?.key === 'INR'" class="h-[15px]" />
        <div v-else class="h-[18px] w-[13px]" />
        <div class="relative top-px -mr-0.5 ml-[3px]">
          {{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent class="absolute top-0 left-0 w-full data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight sm:w-auto">
        <ul class="bg-argon-menu-bg min-w-72 rounded p-1 text-sm text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <li class="flex items-center justify-between gap-6 px-3 py-2.5">
            <div>
              <div class="font-semibold text-slate-700">Net worth</div>
              <div v-if="aggregate.isStale || aggregate.readiness !== 'ready'" class="text-xs font-normal text-slate-500 capitalize">
                {{ aggregate.isStale ? 'Stale' : aggregate.readiness }}
              </div>
            </div>
            <div class="font-mono text-lg font-bold text-argon-700/80">{{ formattedNetWorth }}</div>
          </li>

          <li divider class="my-1 h-px w-full bg-slate-400/30" />

          <li v-for="group in visibleGroups" :key="group.group" class="flex items-center justify-between gap-6 px-3 py-2">
            <div>
              <div class="font-semibold text-slate-700">{{ financialMenuLabels[group.group] }}</div>
              <div v-if="group.state !== 'ready' && group.state !== 'stale'" class="text-xs font-normal text-slate-500 capitalize">
                {{ group.state }}
              </div>
              <div v-else-if="group.grossLiabilities" class="text-xs font-normal text-slate-500">
                Assets {{ formatValue(group.grossAssets) }} · Liabilities {{ formatValue(group.grossLiabilities) }}
              </div>
              <div v-else-if="group.isStale" class="text-xs font-normal text-slate-500">Stale</div>
            </div>
            <div class="font-mono font-semibold text-slate-700">
              {{ group.state === 'ready' || group.state === 'stale' ? formatValue(group.currentValue) : '--' }}
            </div>
          </li>

          <li v-if="visibleGroups.length === 0" class="px-3 py-4 text-center font-normal text-slate-500">
            No financial positions yet
          </li>
        </ul>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { storeToRefs } from 'pinia';
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuTrigger } from 'reka-ui';
import { getCurrency } from '../stores/currency.ts';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useFinancials } from '../stores/financials.ts';
import { financialMenuLabels } from './financialMenuLabels.ts';

const rootRef = Vue.ref<HTMLElement>();

defineExpose({
  $el: rootRef,
});

const currency = getCurrency();
const financials = useFinancials();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const { financialPositionAggregate: aggregate } = storeToRefs(financials);

const visibleGroups = Vue.computed(() => {
  return aggregate.value.groups.filter(group => {
    return group.state !== 'ready' || group.grossAssets !== 0n || group.grossLiabilities !== 0n;
  });
});
const formattedNetWorth = Vue.computed(() => {
  if (!currency.isLoaded || aggregate.value.netWorth === undefined) return '--';
  return formatValue(aggregate.value.netWorth);
});
const totalNetWorth = Vue.computed(() => {
  if (formattedNetWorth.value === '--') return ['--', '--'];
  return formattedNetWorth.value.split('.');
});

function formatValue(value: bigint): string {
  return microgonToMoneyNm(value).format('0,0.00');
}
</script>
