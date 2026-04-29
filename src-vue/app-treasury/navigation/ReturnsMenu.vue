<!-- prettier-ignore -->
<template>
  <div ref="rootRef" @mouseenter="onMouseEnter" @mouseleave="onMouseLeave">
    <DropdownMenuRoot :openDelay="0" :closeDelay="0" class="relative pointer-events-auto" v-model:open="isOpen">
      <DropdownMenuTrigger
        Trigger
        class="flex flex-row items-center justify-center text-[17px] font-semibold font-mono text-argon-600/70 cursor-pointer border rounded-md hover:bg-slate-400/10 px-3.5 h-[30px] focus:outline-none hover:border-slate-400/50"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
          <div class="ml-[3px] relative top-px -mr-0.5">
            0% RTD
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
          class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade z-50 data-[state=open]:transition-all">
          <div class="bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">

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
import { getCurrency } from '../../stores/currency.ts';
import ArgonSign from '../../assets/currencies/argon.svg?component';
import DollarSign from '../../assets/currencies/dollar.svg?component';
import EuroSign from '../../assets/currencies/euro.svg?component';
import PoundSign from '../../assets/currencies/pound.svg?component';
import RupeeSign from '../../assets/currencies/rupee.svg?component';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { ICurrencyKey, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { getConfig } from '../../stores/config.ts';
import { PortfolioTab } from '../../panels/interfaces/IPortfolioTab.ts';
import { IS_TREASURY_APP, IS_OPERATIONS_APP } from '../../lib/Env.ts';

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
  let rawValue: bigint;
  if (IS_OPERATIONS_APP) {
    rawValue = wallets.totalOperationalResources;
  } else {
    rawValue = wallets.totalTreasuryResources;
  }
  const value = microgonToMoneyNm(rawValue).format('0,0.00');
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
  }, 250);
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
