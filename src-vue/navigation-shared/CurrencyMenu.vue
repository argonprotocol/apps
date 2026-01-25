<!-- prettier-ignore -->
<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="flex flex-row items-center justify-center text-sm/6 font-semibold text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 px-3 h-[30px] focus:outline-none hover:border-slate-400/50"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
        <slot>
          <ArgonSign v-if="!currency?.record?.key || currency?.record?.key === 'ARGN'" class="h-[14px]" />
          <DollarSign v-else-if="currency?.record?.key === 'USD'" class="h-[16px]" />
          <EuroSign v-else-if="currency?.record?.key === 'EUR'" class="h-[16px]" />
          <PoundSign v-else-if="currency?.record?.key === 'GBP'" class="h-[16px]" />
          <RupeeSign v-else-if="currency?.record?.key === 'INR'" class="h-[16px]" />
          <div v-else class="h-[18px] w-[14px]"></div>
          <div class="text-lg font-bold ml-[3px] relative top-px -mr-0.5">
            {{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
          </div>
        </slot>
      </DropdownMenuTrigger>

      <DropdownMenuPortal>
        <DropdownMenuContent
          @mouseenter="onMouseEnter"
          @mouseleave="onMouseLeave"
          @pointerDownOutside="clickOutside"
          :align="'end'"
          :alignOffset="0"
          :sideOffset="-3"
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad z-50 data-[state=open]:transition-all">
          <div
            class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <DropdownMenuItem
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
              <div class="flex flex-row justify-end font-light text-gray-400 text-sm mt-0.5">
                1 ARGN = {{ record.symbol }}{{ microgonToNm(1_000_000n, key).format('0,0.00') }},
                1 ARGNOT = {{ record.symbol }}{{ micronotToNm(1_000_000n, key).format('0,0.00') }},
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem v-if="IS_OPERATIONS_APP" class="pt-3! pb-2.5! px-2! focus:bg-transparent! cursor-default!">
              <button @click="openPortfolioPanel" class="text-md py-2 px-5 text-white bg-argon-600 border border-argon-700 hover:inner-button-shadow rounded-md w-full cursor-pointer">
                Open Portfolio Overlay
              </button>
            </DropdownMenuItem>
          </div>
          <DropdownMenuArrow :width="18" :height="10" class="mt-[0px] fill-white stroke-gray-300" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { getCurrency } from '../stores/currency';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import { useWallets } from '../stores/wallets';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { ICurrencyKey, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getConfig } from '../stores/config.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import { IS_CAPITAL_APP, IS_OPERATIONS_APP } from '../lib/Env.ts';

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const config = getConfig();
const currency = getCurrency();
const wallets = useWallets();

const { microgonToMoneyNm, microgonToNm, micronotToNm } = createNumeralHelpers(currency);

const totalNetWorth = Vue.computed(() => {
  if (!currency.isLoaded) {
    return ['--', '--'];
  }
  const value = microgonToMoneyNm(wallets.totalNetWorth).format('0,0.00');
  return value.split('.');
});

let mouseLeaveTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function onMouseEnter() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = undefined;
  isOpen.value = true;
}

function onMouseLeave() {
  if (mouseLeaveTimeoutId) {
    clearTimeout(mouseLeaveTimeoutId);
  }
  mouseLeaveTimeoutId = setTimeout(() => {
    isOpen.value = false;
  }, 100);
}

function clickOutside(e: PointerDownOutsideEvent) {
  const isChildOfTrigger = !!(e.target as HTMLElement)?.closest('[Trigger]');
  if (!isChildOfTrigger) return;

  isOpen.value = true;
  setTimeout(() => {
    isOpen.value = true;
  }, 200);
  e.detail.originalEvent.stopPropagation();
  e.detail.originalEvent.preventDefault();
  e.stopPropagation();
  e.preventDefault();
  return false;
}

function setCurrencyKey(key: ICurrencyKey) {
  if (key === UnitOfMeasurement.ARGN || config.isValidJurisdiction) {
    currency.setKey(key);
  } else {
    basicEmitter.emit('openJurisdictionOverlay');
  }
}

function openPortfolioPanel(): void {
  basicEmitter.emit('openPortfolioPanel', PortfolioTab.Overview);
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
