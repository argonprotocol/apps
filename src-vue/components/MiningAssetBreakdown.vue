<template>
  <div class="text-md relative flex w-full flex-col items-center whitespace-nowrap">
    <template v-if="props.show !== 'OnlyTotal'">
      <Header :tooltip="breakdown.help.availableMicrogons" :height="itemHeight">
        Bidding Reserves
        <template #icon><ArgonIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.availableMicrogons).format('0,0.00') }}
        </template>
      </Header>
      <SubItem :tooltip="breakdown.help.unusedMicrogons" :height="itemHeight" :showArrow="props.showArrows">
        {{ microgonToArgonNm(breakdown.unusedMicrogons).format('0,0.[00]') }} ARGN Available
      </SubItem>
      <SubItem :tooltip="breakdown.help.unusedMicronots" :height="itemHeight" :showArrow="props.showArrows">
        {{ microgonToArgonNm(breakdown.unusedMicronots).format('0,0.[00]') }} ARGNOT Available
      </SubItem>

      <Header :tooltip="breakdown.help.bidTotal" class="border-dashed" :height="itemHeight">
        Winning
        <span class="hidden 2xl:inline">Mining</span>
        Bids ({{ numeral(breakdown.bidTotalCount).format('0,0') }})
        <template #icon><MiningBidIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.bidTotalCost).format('0,0.00') }}
        </template>
      </Header>
      <SubItem :tooltip="breakdown.help.bidMicrogons" :height="itemHeight">
        {{ microgonToArgonNm(breakdown.bidMicrogons).format('0,0.[00]') }} ARGN Locked
      </SubItem>
      <SubItem :tooltip="breakdown.help.bidMicronots" :height="itemHeight">
        {{ microgonToArgonNm(breakdown.bidMicronots).format('0,0.[00]') }} ARGNOT Locked
      </SubItem>

      <Header :tooltip="breakdown.help.seatTotal" class="border-dashed" :height="itemHeight">
        Active
        <span class="hidden 2xl:inline">Mining</span>
        Seats ({{ numeral(breakdown.seatTotalCount).format('0,0') }})
        <template #icon><MiningSeatIcon class="h-7 w-7" /></template>
        <template #value>
          {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.seatTotalCost).format('0,0.00') }}
        </template>
      </Header>
      <SubItem :tooltip="breakdown.help.seatMicrogons" :height="itemHeight">
        {{ microgonToArgonNm(breakdown.seatMicrogons).format('0,0.[00]') }} ARGN to Collect
      </SubItem>
      <SubItem :tooltip="breakdown.help.seatMicronots" :height="itemHeight">
        {{ microgonToArgonNm(breakdown.seatMicronots).format('0,0.[00]') }} ARGNOT to Collect
      </SubItem>

      <Expenses :tooltip="breakdown.help.transactionFeesTotal" :height="itemHeight">
        <span class="hidden xl:inline">Operational</span>
        Expenses
        <template #value>
          -{{ currency.symbol }}{{ microgonToMoneyNm(breakdown.transactionFeesTotal).format('0,0.00') }}
        </template>
      </Expenses>

      <Expenses :tooltip="breakdown.help.transactionFeesTotal" class="border-dashed" :height="itemHeight">
        ARGN
        <span class="hidden xl:inline">Mining</span>
        Losses
        <template #value>-{{ currency.symbol }}{{ microgonToMoneyNm(0n).format('0,0.00') }}</template>
      </Expenses>
    </template>

    <Total
      v-if="props.show === 'All' || props.show === 'OnlyTotal'"
      :tooltip="breakdown.help.totalMiningResources"
      :class="props.show === 'OnlyTotal' ? 'h-full' : ''"
      :height="itemHeight">
      Total Value
      <template #value>
        {{ currency.symbol }}{{ microgonToMoneyNm(breakdown.totalMiningResources).format('0,0.00') }}
      </template>
    </Total>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
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

const props = withDefaults(
  defineProps<{
    show?: 'All' | 'AllExceptTotal' | 'OnlyTotal';
    align?: 'left' | 'right';
    showArrows?: boolean;
  }>(),
  {
    show: 'All',
    align: 'left',
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

<style scoped>
@reference "../main.css";

.Row {
  @apply hover:text-argon-600 hover:bg-argon-200/10 flex h-[9.091%] w-full flex-row items-center;
}
</style>
