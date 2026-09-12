<template>
  <section class="flex min-h-0 flex-col overflow-hidden bg-white px-4 py-4">
    <header class="mb-3 font-semibold tracking-wide text-slate-500 uppercase">
      {{ title }}
    </header>

    <div class="h-48 min-h-0 overflow-y-auto">
      <table class="w-full" :aria-label="ariaLabel">
        <thead>
          <tr class="border-b border-slate-300 text-left font-bold text-slate-600">
            <th class="pb-2">Position</th>
            <th class="pb-2">Bid</th>
            <th class="pb-2 text-right">Bidding Account</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="sortedBids.length === 0">
            <td colspan="3" class="py-3 text-slate-500">{{ emptyText }}</td>
          </tr>
          <template v-for="(bid, index) in visibleBids" v-else :key="bid.address">
            <tr class="border-b border-slate-200 last:border-b-0">
              <td class="py-2">{{ (bid.bidPosition ?? index) + 1 }}</td>
              <td class="py-2 font-mono">
                {{ currency.symbol }}{{ microgonToMoneyNm(bid.microgonsPerSeat ?? 0n).format('0,0.00') }}
              </td>
              <td class="py-2 text-right">
                <span v-if="typeof bid.subAccountIndex === 'number'" class="text-slate-600">You</span>
                <span v-else class="font-mono">{{ bid.address.slice(0, 8) }}...{{ bid.address.slice(-6) }}</span>
              </td>
            </tr>
            <tr v-if="index === 0 && hiddenBidCount > 0">
              <td
                colspan="3"
                class="bg-slate-50 px-3 py-1 text-sm text-slate-500 inset-shadow-sm inset-shadow-slate-300/40"
              >
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between text-left hover:text-slate-700"
                  @click="isExpanded = true"
                >
                  <span>
                    Show {{ numeral(hiddenBidCount).format('0,0') }} hidden bid{{ hiddenBidCount === 1 ? '' : 's' }}
                  </span>
                  <span>{{ numeral(ownedBidCount).format('0,0') }} owned by you</span>
                </button>
              </td>
            </tr>
          </template>
          <tr v-if="isExpanded && collapsibleBidCount > 0">
            <td
              colspan="3"
              class="bg-slate-50 px-3 py-1 text-center text-sm text-slate-500 inset-shadow-sm inset-shadow-slate-300/40"
            >
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="isExpanded = false">
                Collapse {{ numeral(collapsibleBidCount).format('0,0') }} bid{{ collapsibleBidCount === 1 ? '' : 's' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer class="mt-3 flex justify-between border-t border-slate-300 pt-3 text-slate-500">
      <span>{{ auctionStatus }}</span>
      <span>
        {{ numeral(sortedBids.length).format('0,0') }} network bids, {{ numeral(ownedBidCount).format('0,0') }} by you
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IWinningBid } from '@argonprotocol/apps-core';
import numeral from '../../lib/numeral.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';

const props = defineProps<{
  ariaLabel: string;
  title: string;
  bids: IWinningBid[];
  currentTick: number;
  closesAtTick?: number;
  emptyText: string;
}>();

const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const isExpanded = Vue.ref(false);

const sortedBids = Vue.computed(() => {
  return [...props.bids].sort((a, b) => (a.bidPosition ?? 0) - (b.bidPosition ?? 0));
});

const ownedBidCount = Vue.computed(() => {
  return sortedBids.value.filter(bid => typeof bid.subAccountIndex === 'number').length;
});

const collapsedBids = Vue.computed(() => {
  if (sortedBids.value.length <= 3) return sortedBids.value;

  const ownedBids = sortedBids.value.filter(bid => typeof bid.subAccountIndex === 'number');
  const selectedBids = new Set<IWinningBid>();
  for (const bid of [
    sortedBids.value[0],
    ownedBids[0],
    ownedBids[ownedBids.length - 1],
    sortedBids.value[sortedBids.value.length - 1],
    sortedBids.value[sortedBids.value.length - 2],
  ]) {
    if (bid) selectedBids.add(bid);
    if (selectedBids.size === 3) break;
  }
  return sortedBids.value.filter(bid => selectedBids.has(bid));
});

const collapsibleBidCount = Vue.computed(() => sortedBids.value.length - collapsedBids.value.length);
const hiddenBidCount = Vue.computed(() => (isExpanded.value ? 0 : collapsibleBidCount.value));
const visibleBids = Vue.computed(() => (isExpanded.value ? sortedBids.value : collapsedBids.value));

const auctionStatus = Vue.computed(() => {
  if (props.closesAtTick === undefined) return 'Closed yesterday';

  const remainingTicks = Math.max(props.closesAtTick - props.currentTick, 0);
  if (remainingTicks === 0) return 'Auction closed';

  const remainingSeconds = Math.ceil((remainingTicks * TICK_MILLIS) / 1_000);
  if (remainingSeconds < 60) {
    return `Closes in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
  }

  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `Closes in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;

  const remainingHours = Math.floor(remainingMinutes / 60);
  return `Closes in ${remainingHours} hour${remainingHours === 1 ? '' : 's'}`;
});
</script>
