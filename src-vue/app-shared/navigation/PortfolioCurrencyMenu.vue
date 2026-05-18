<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">

    <div>
      <NavigationMenuItem class="pointer-events-auto">
        <NavigationMenuTrigger
          Trigger
          class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-r-md border border-l-0 border-slate-400/50 px-1.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
        >
          <ChevronDownIcon class="w-4" />
        </NavigationMenuTrigger>

        <NavigationMenuContent
          class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto"
        >
          <div
            class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <NavigationMenuLink
              v-for="(record, key) of currency?.recordsByKey"
              :key="key"
              @click="setCurrencyKey(key)"
              :class="currency?.record?.key === key ? '!text-argon-500' : '!text-slate-700'"
              class="group/item hover:!text-argon-600 hover:bg-argon-menu-hover flex flex-col cursor-pointer border-b border-slate-400/30 py-3 pr-1 pl-5 last:border-b-0"
            >
              <div class="relative flex flex-row items-center justify-end font-bold text-gray-900">
                <span v-if="currency?.record?.key === key" class="grow text-right pr-2">
                  <CheckIcon class="h-5 inline-block relative -top-0.5" aria-hidden="true" />
                </span>
                <span
                  ItemWrapper
                  :class="currency?.record?.key === key ? 'opacity-100' : 'opacity-80'"
                  class="text-right group-hover/item:opacity-100"
                >
                  {{ record.name }} ({{ record.key }})
                </span>
                <span class="ml-2" v-html="record.symbol" />
              </div>
              <div class="flex flex-row justify-end font-light text-gray-500 text-sm mt-0.5 whitespace-nowrap">
                1 ARGN = {{ record.symbol }}{{ microgonToNm(1_000_000n, key).format('0,0.00') }},
                1 ARGNOT = {{ record.symbol }}{{ micronotToNm(1_000_000n, key).format('0,0.00') }},
              </div>
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
import { getCurrency } from '../../stores/currency.ts';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { ICurrencyKey, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getConfig } from '../../stores/config.ts';
import { PortfolioTab } from '../../app-operations/panels/interfaces/IPortfolioTab.ts';

const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const config = getConfig();
const currency = getCurrency();
const wallets = useWallets();

const { microgonToMoneyNm, microgonToNm, micronotToNm } = createNumeralHelpers(currency);

function setCurrencyKey(key: ICurrencyKey) {
  if (key === UnitOfMeasurement.ARGN || config.isValidJurisdiction) {
    currency.setKey(key);
  } else {
    basicEmitter.emit('openJurisdictionOverlay', { setCurrencyKey: key });
  }
}
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
