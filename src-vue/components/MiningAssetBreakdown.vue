<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true">
    <div
      class="MiningAssetBreakdown"
      :class="twMerge('text-md relative flex w-full flex-col items-center whitespace-nowrap', props.class)">
      <template v-if="props.show !== 'OnlyTotal'">
        <Header
          :tooltip="breakdown.help.biddingReserves"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          class="border-0">
          Bidding Reserves
          <template #icon><ArgonIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.biddingReserves).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.unusedMicrogons"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="props.showMoveButtons"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningReserveArgon"
          :moveTo="MoveTo.Holding"
        >
          {{ microgonToArgonNm(breakdown.unusedMicrogons).format('0,0.[00]') }} ARGN Available
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.unusedMicronots"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :showMoveButton="props.showMoveButtons"
          :spacerWidth="spacerWidth"
          :moveFrom="MoveFrom.MiningReserveArgonot"
          :moveTo="MoveTo.Holding"
        >
          {{ microgonToArgonNm(breakdown.unusedMicronots).format('0,0.[00]') }} ARGNOT Available
        </SubItem>

        <Header
          :tooltip="breakdown.help.bidTotal"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          class="border-dashed">
          Winning
          <span class="hidden 2xl:inline">Mining</span>
          Bids ({{ numeral(breakdown.bidTotalCount).format('0,0') }})
          <template #icon><MiningBidIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bidTotalCost).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.bidMicrogons"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.bidMicrogons).format('0,0.[00]') }} ARGN Locked
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.bidMicronots"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.bidMicronots).format('0,0.[00]') }} ARGNOT Locked
        </SubItem>

        <Header
          :tooltip="breakdown.help.seatTotal"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          class="border-dashed">
          Active
          <span class="hidden 2xl:inline">Mining</span>
          Seats ({{ numeral(breakdown.seatActiveCount).format('0,0') }})
          <template #icon><MiningSeatIcon class="h-7 w-7" /></template>
          <template #value>
            {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.expectedSeatValue).format('0,0.00') }}
          </template>
        </Header>
        <SubItem
          :tooltip="breakdown.help.expectedSeatMicrogons"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth">
          {{ microgonToArgonNm(breakdown.expectedSeatMicrogons).format('0,0.[00]') }} ARGN Expected
        </SubItem>
        <SubItem
          :tooltip="breakdown.help.expectedSeatMicronots"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          :tooltipSide="tooltipSide">
          {{ microgonToArgonNm(breakdown.expectedSeatMicronots).format('0,0.[00]') }} ARGNOT Expected
        </SubItem>

        <Expenses
          :tooltip="breakdown.help.transactionFeesTotal"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth">
          <span class="hidden xl:inline">Operational</span>
          Expenses
          <template #value>
            -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.transactionFeesTotal).format('0,0.00') }}
          </template>
        </Expenses>

        <Expenses
          :tooltip="breakdown.help.miningLosses"
          :tooltipSide="tooltipSide"
          :height="itemHeight"
          :spacerWidth="spacerWidth"
          class="border-dashed">
          ARGN
          <span class="hidden xl:inline">Mining</span>
          Losses
          <template #value>-{{ currency.symbol }}{{ microgonToMoneyNm(0n).format('0,0.00') }}</template>
        </Expenses>
      </template>

      <Total
        v-if="props.show === 'All' || props.show === 'OnlyTotal'"
        :tooltip="breakdown.help.totalMiningResources"
        :tooltipSide="tooltipSide"
        :height="itemHeight"
        :spacerWidth="spacerWidth"
        :class="props.show === 'OnlyTotal' ? 'h-full' : ''">
        Total Value
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalMiningResources).format('0,0.00') }}
        </template>
      </Total>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { twMerge } from 'tailwind-merge';
import ArgonIcon from '../assets/resources/argon.svg?component';
import MiningBidIcon from '../assets/resources/mining-bid.svg?component';
import MiningSeatIcon from '../assets/resources/mining-seat.svg?component';
import { useCurrency } from '../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import Header from './asset-breakdown/Header.vue';
import SubItem from './asset-breakdown/SubItem.vue';
import Expenses from './asset-breakdown/Expenses.vue';
import Total from './asset-breakdown/Total.vue';
import { TooltipProvider } from 'reka-ui';
import { MoveFrom, MoveTo } from '../overlays/MoveCapitalButton.vue';

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
    align?: 'left' | 'right';
    showMoveButtons?: boolean;
    spacerWidth?: string;
    class?: string;
    tooltipSide?: 'right' | 'top';
  }>(),
  {
    show: 'All',
    align: 'left',
    tooltipSide: 'right',
  },
);

const currency = useCurrency();
const breakdown = useMiningAssetBreakdown();

const { microgonToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const itemHeight = Vue.computed(() => {
  let total = 12;
  if (props.show === 'AllExceptTotal') {
    total = 11;
  } else if (props.show === 'OnlyTotal') {
    total = 1;
  } else if (props.show === 'All') {
    return 'auto';
  }
  return 100 / total;
});
</script>

<style>
@reference "../main.css";

.MiningAssetBreakdown {
  [data-reka-popper-content-wrapper] div {
    pointer-events: none !important;
  }
}
</style>
