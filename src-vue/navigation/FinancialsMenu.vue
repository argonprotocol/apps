<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <HoverCardRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
      <HoverCardTrigger as="div" Trigger
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
      </HoverCardTrigger>

      <HoverCardPortal>
        <HoverCardContent 
          @pointerDownOutside="clickOutside"
          :align="'end'" 
          :alignOffset="-6" 
          :sideOffset="-3" 
          class="z-50 data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFad data-[state=open]:transition-all"
        >
          <div class="flex flex-col p-1 shrink rounded bg-white text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
            <a
              v-for="(record, key) of currency?.records as Record<ICurrencyKey, ICurrencyRecord>"
              :key="key"
              @click="setCurrencyKey(key)"
              :class="currency?.record?.key === key ? '!text-argon-500' : '!text-slate-700'"
              class="group/item flex flex-row justify-between py-1 px-2 border-b last:border-b-0 border-argon-menu-hover hover:!text-argon-600 hover:bg-argon-menu-hover cursor-pointer"
            >
              <span
                :class="currency?.record?.key === key ? 'opacity-100' : 'opacity-80'"
                class="font-medium group-hover/item:opacity-100 mr-4"
              >
                {{ record.name }}
              </span>
              <span class="w-8 text-center" v-html="record.symbol"></span>
            </a>
          </div>
          <HoverCardArrow :width="18" :height="10" class="fill-white stroke-gray-300 mt-[0px]" />
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCardRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  HoverCardArrow,
  HoverCardContent,
  HoverCardPortal,
  HoverCardRoot,
  HoverCardTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import { useCurrency } from '../stores/currency';
import { CurrencyKey, ICurrencyRecord, type ICurrencyKey } from '../lib/Currency';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import basicEmitter from '../emitters/basicEmitter';
import { useConfig } from '../stores/config';
import { useWallets } from '../stores/wallets';
import { createNumeralHelpers } from '../lib/numeral.ts';

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const currency = useCurrency();
const config = useConfig();
const wallets = useWallets();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const totalNetWorth = Vue.computed(() => {
  if (!currency.isLoaded) {
    return ['--', '--'];
  }
  const value = microgonToMoneyNm(wallets.totalNetWorth).format('0,0.00');
  return value.split('.');
});

function setCurrencyKey(key: ICurrencyKey) {
  if (key === CurrencyKey.ARGN || config.isValidJurisdiction) {
    currency.setCurrencyKey(key);
  } else {
    basicEmitter.emit('openComplianceOverlay');
  }
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
</script>
