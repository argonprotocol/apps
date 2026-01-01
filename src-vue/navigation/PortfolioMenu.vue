<!-- prettier-ignore -->
<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="flex flex-row items-center justify-center text-sm/6 font-semibold text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 px-3 h-[30px] focus:outline-none hover:border-slate-400/50"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
        <ArgonSign v-if="!currency?.record?.key || currency?.record?.key === 'ARGN'" class="h-[14px]" />
        <DollarSign v-else-if="currency?.record?.key === 'USD'" class="h-[16px]" />
        <EuroSign v-else-if="currency?.record?.key === 'EUR'" class="h-[16px]" />
        <PoundSign v-else-if="currency?.record?.key === 'GBP'" class="h-[16px]" />
        <RupeeSign v-else-if="currency?.record?.key === 'INR'" class="h-[16px]" />
        <div v-else class="h-[18px] w-[14px]"></div>
        <div class="text-lg font-bold ml-[3px] relative top-px -mr-0.5">
          {{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
        </div>
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
              class="group/item hover:!text-argon-600 hover:bg-argon-menu-hover relative flex cursor-pointer flex-row items-center justify-between border-b border-slate-400/30 py-3 pr-1 pl-10 font-bold text-gray-900 last:border-b-0">
              <span v-if="currency?.record?.key === key" class="absolute top-1/2 left-3 -translate-y-1/2">
                <CheckIcon class="size-5" aria-hidden="true" />
              </span>
              <span
                ItemWrapper
                :class="currency?.record?.key === key ? 'opacity-100' : 'opacity-80'"
                class="grow text-right group-hover/item:opacity-100">
                {{ record.name }} ({{ record.key }})
              </span>
              <span class="ml-2" v-html="record.symbol" />
            </DropdownMenuItem>
            <PortfolioSubmenu @close="isOpen = false" />
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
import PortfolioSubmenu from './PortfolioSubmenu.vue';

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const config = getConfig();
const currency = getCurrency();
const wallets = useWallets();

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm, micronotToMoneyNm } = createNumeralHelpers(currency);

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
    basicEmitter.emit('openComplianceOverlay');
  }
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
    @apply grow font-bold whitespace-nowrap text-gray-900;
  }
}
</style>
