<template>
  <div class="flex min-h-0 flex-col rounded border border-slate-400/30 bg-white px-4 py-3 shadow">
    <div class="mb-3 flex items-end justify-between gap-x-4">
      <div class="text-lg font-bold text-slate-800/80">{{ title }}</div>
      <div class="text-xs tracking-wide text-slate-500 uppercase">
        {{ sortedBids.length }} network bids, {{ ownedBidCount }} by you
      </div>
    </div>

    <div v-if="sortedBids.length === 0" class="flex grow items-center justify-center text-slate-500">
      {{ emptyText }}
    </div>
    <div v-else class="min-h-0 grow overflow-y-auto">
      <table class="w-full">
        <thead>
          <tr>
            <th>#</th>
            <th>Amount</th>
            <th>Bid Submitted</th>
            <th class="text-right">Bidding Account</th>
          </tr>
        </thead>
        <tbody class="font-mono font-light">
          <template v-for="(bid, index) in visibleBids" :key="bid.address">
            <tr>
              <td class="text-left opacity-50">{{ (bid.bidPosition ?? index) + 1 }})</td>
              <td class="text-left">
                {{ currency.symbol }}{{ microgonToMoneyNm(bid.microgonsPerSeat ?? 0n).format('0,0.00') }}
              </td>
              <td class="text-left">{{ tickFromNow(bid.lastBidAtTick) }}</td>
              <td class="relative text-right">
                {{ bid.address.slice(0, 10) }}...{{ bid.address.slice(-7) }}
                <span v-if="typeof bid.subAccountIndex === 'number'" owned-badge>YOU</span>
              </td>
            </tr>
            <tr v-if="index === 0 && hiddenBidCount > 0">
              <td colspan="4" class="bg-fuchsia-50/70 px-3 py-1.5 text-sm text-slate-600">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center justify-between text-left hover:text-slate-800"
                  @click="isExpanded = true"
                >
                  <span>Show {{ hiddenBidCount }} hidden bid{{ hiddenBidCount === 1 ? '' : 's' }}</span>
                  <span>{{ ownedBidCount }} owned by you</span>
                </button>
              </td>
            </tr>
          </template>
          <tr v-if="isExpanded && collapsibleBidCount > 0">
            <td colspan="4" class="bg-fuchsia-50/70 px-3 py-1.5 text-center text-sm text-slate-600">
              <button type="button" class="cursor-pointer hover:text-slate-800" @click="isExpanded = false">
                Collapse {{ collapsibleBidCount }} bid{{ collapsibleBidCount === 1 ? '' : 's' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import type { IWinningBid } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../lib/Env.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = defineProps<{
  title: string;
  emptyText: string;
  bids: IWinningBid[];
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
  if (sortedBids.value.length <= 2) {
    return sortedBids.value;
  }

  const lastIndex = sortedBids.value.length - 1;
  return sortedBids.value.filter((bid, index) => {
    return index === 0 || index === lastIndex || typeof bid.subAccountIndex === 'number';
  });
});

const collapsibleBidCount = Vue.computed(() => sortedBids.value.length - collapsedBids.value.length);
const hiddenBidCount = Vue.computed(() => (isExpanded.value ? 0 : collapsibleBidCount.value));
const visibleBids = Vue.computed(() => (isExpanded.value ? sortedBids.value : collapsedBids.value));

function tickFromNow(tick?: number) {
  if (!tick) {
    return '---';
  }

  return dayjs
    .utc(tick * TICK_MILLIS)
    .local()
    .fromNow();
}
</script>

<style scoped>
@reference "../main.css";

[owned-badge] {
  @apply bg-argon-600 absolute top-1/2 right-0 -translate-y-1/2 rounded px-1.5 pb-0.25 text-sm text-white;
}

table {
  thead th {
    @apply text-argon-600/80 border-b border-slate-300 pb-2 text-left text-sm font-bold;
  }

  thead th:last-child {
    @apply text-right;
  }

  tbody td {
    @apply border-b border-slate-200 py-2 text-sm;
  }

  tbody tr:last-child td {
    @apply border-b-0;
  }
}
</style>
