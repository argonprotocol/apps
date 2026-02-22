<template>
  <HoverCardRoot v-model:open="isOpen" @update:open="updateIsOpen">
    <HoverCardTrigger CardTrigger @click="clickTrigger" class="inline-block cursor-pointer outline-none">
      <AlertIcon class="relative mr-2 inline-block h-10 w-10 text-yellow-700" />
    </HoverCardTrigger>
    <HoverCardPortal>
      <HoverCardContent
        @pointerDownOutside="clickOutside"
        @focusOutside="focusOutside"
        :alignOffset="-50"
        :sideOffset="5"
        :collisionPadding="24"
        align="end"
        class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade text-md z-100 w-[500px] rounded-md border border-gray-800/20 bg-white px-4 pt-4 pb-5 text-left leading-5.5 text-gray-600 shadow-xl select-none data-[state=open]:transition-all">
        <p>
          You need a minimum of {{ currency.symbol }}{{ microgonToMoneyNm(idealCapitalCommitment).format('0,0.00') }} in
          order to have a chance at fulfilling your goal of winning {{ seatGoalCount }} seats.
        </p>
        <button
          @click="increaseCapitalCommitment"
          class="border-argon-600/30 mt-4 flex w-full cursor-pointer flex-row items-center justify-center rounded-md border bg-slate-200 px-4 py-1.5 font-bold">
          <IncreaseIcon class="relative -mt-0.5 mr-2 inline-block size-4" />
          <span class="">
            Increase Commitment to {{ currency.symbol
            }}{{ microgonToMoneyNm(idealCapitalCommitment).format('0,0.[00]') }}
          </span>
        </button>
        <HoverCardArrow :width="24" :height="12" class="-mt-px ml-1.5 fill-white stroke-gray-400/30" />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  FocusOutsideEvent,
  HoverCardArrow,
  HoverCardContent,
  HoverCardPortal,
  HoverCardRoot,
  HoverCardTrigger,
  PointerDownOutsideEvent,
} from 'reka-ui';
import AlertIcon from '../../assets/alert.svg?component';
import { BiddingCalculator } from '@argonprotocol/apps-core';
import { getConfig } from '../../stores/config';
import { getCurrency } from '../../stores/currency';
import { createNumeralHelpers } from '../../lib/numeral';
import IncreaseIcon from '../../assets/increase.svg?component';

const props = defineProps<{
  calculator: BiddingCalculator;
  seatGoalCount: number;
  idealCapitalCommitment: bigint;
}>();

const emit = defineEmits<{
  (e: 'increaseCapitalCommitment'): void;
}>();

const config = getConfig();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isClickedOpen = Vue.ref(false);
let wasRecentlyClickedOutside = false;

function increaseCapitalCommitment() {
  emit('increaseCapitalCommitment');
  isOpen.value = false;
}

function clickOutside(e: PointerDownOutsideEvent) {
  wasRecentlyClickedOutside = true;
  setTimeout(() => {
    wasRecentlyClickedOutside = false;
  }, 200);

  if (!(e.target as HTMLElement)?.closest('[CardTrigger]')) {
    return;
  }

  if (isOpen.value && !isClickedOpen.value) {
    isClickedOpen.value = true;
    e.stopPropagation();
    e.preventDefault();
  } else if (isOpen.value && isClickedOpen.value) {
    isClickedOpen.value = false;
    isOpen.value = false;
  }
}

function focusOutside(e: FocusOutsideEvent) {
  if (isClickedOpen.value) {
    e.stopPropagation();
    e.preventDefault();
  }
}

function clickTrigger(e: MouseEvent) {
  if (wasRecentlyClickedOutside) return;

  if (!isOpen.value) {
    isClickedOpen.value = true;
    isOpen.value = true;
  }
}

function updateIsOpen(open: boolean) {
  if (!open && !wasRecentlyClickedOutside && isClickedOpen.value) {
    isOpen.value = true;
  } else if (!open) {
    isClickedOpen.value = false;
  }
}
</script>
