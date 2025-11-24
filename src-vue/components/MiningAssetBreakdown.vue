<template>
  <div class="text-md relative flex w-full flex-col items-center whitespace-nowrap">
    <div
      v-if="props.show !== 'OnlyTotal'"
      class="flex min-h-[calc(100%/7)] w-full flex-col border-t border-gray-600/40 pt-2 pb-3">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <ArgonIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">Bidding Reserves</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.availableMicrogons).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.availableMicrogons" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.unusedMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.unusedMicrogons" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(breakdown.unusedMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.unusedMicronots" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div v-if="props.show !== 'OnlyTotal'" class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <MiningBidIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">
            Winning
            <span class="hidden 2xl:inline">Mining</span>
            Bids ({{ numeral(breakdown.bidTotalCount).format('0,0') }})
          </div>
          <div class="pr-1">{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bidTotalCost).format('0,0.00') }}</div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.bidTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.bidMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.bidMicrogons" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(breakdown.bidMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.bidMicronots" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div v-if="props.show !== 'OnlyTotal'" class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <MiningSeatIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">
            Active
            <span class="hidden 2xl:inline">Mining</span>
            Seats ({{ numeral(breakdown.seatTotalCount).format('0,0') }})
          </div>
          <div class="pr-1">{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.seatTotalCost).format('0,0.00') }}</div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.seatTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(breakdown.seatMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.seatMicrogons" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(breakdown.seatMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <div v-html="breakdown.help.seatMicronots" />
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </div>
    <div
      v-if="props.show !== 'OnlyTotal'"
      class="flex w-full flex-col items-center gap-y-1 border-t border-gray-600/40 py-2 text-red-900/70">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="flex w-full flex-row items-center hover:text-red-600">
          <div class="grow pl-1">
            <span class="hidden xl:inline">Operational</span>
            Expenses
          </div>
          <div class="pr-1">
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.transactionFeesTotal).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.transactionFeesTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger
          as="div"
          class="flex w-full flex-row items-center border-t border-dashed border-gray-600/20 pt-2 hover:text-red-600">
          <div class="grow pl-1">
            ARGN
            <span class="hidden xl:inline">Mining</span>
            Losses
          </div>
          <div class="pr-1">
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.transactionFeesTotal).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.transactionFeesTotal" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </div>
    <div
      v-if="props.show === 'All' || props.show === 'OnlyTotal'"
      class="flex w-full flex-row items-center justify-between border-t border-b border-gray-600/40 py-2 font-bold">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <div class="grow pl-1">Total Value</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalMiningResources).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <div v-html="breakdown.help.totalMiningResources" />
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import ArgonIcon from '../assets/resources/argon.svg?component';
import MiningBidIcon from '../assets/resources/mining-bid.svg?component';
import MiningSeatIcon from '../assets/resources/mining-seat.svg?component';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
  }>(),
  {
    show: 'All',
  },
);

const currency = useCurrency();
const breakdown = useMiningAssetBreakdown();

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
</script>
