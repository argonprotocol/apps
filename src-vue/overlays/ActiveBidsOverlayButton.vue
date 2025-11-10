<!-- prettier-ignore -->
<template>
  <Popover as="div" class="relative">
    <PopoverButton class="focus:outline-none">
      <slot>
        <span class="cursor-pointer border border-argon-300 text-center text-lg font-bold mt-10 whitespace-nowrap text-argon-600 px-7 py-2 rounded  hover:bg-argon-50/40 hover:border-argon-600 transition-all duration-300">
          View Active Bids
        </span>
      </slot>
    </PopoverButton>
    <PopoverPanel as="div" :class="panelPositioningClasses" class="absolute w-160 h-120 z-100 text-center text-lg font-bold mt-10 bg-white rounded-lg shadow-lg border border-gray-300">
      <div :class="arrowPositioningClasses" class="absolute w-[30px] h-[15px] overflow-hidden">
        <div class="relative top-[5px] left-[5px] w-[20px] h-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
      </div>
      <div class="text-center text-base px-6 pt-5 pb-3 h-full">
        <table class="w-full h-full">
          <thead class="font-bold">
            <tr>
              <th class="text-left pb-2">#</th>
              <th class="text-left pb-2">Amount</th>
              <th class="text-left pb-2">Bid Submitted</th>
              <th class="text-right pb-2">Bidding Account</th>
            </tr>
          </thead>
          <tbody class="font-light font-mono">
            <tr v-for="(bid, index) in allWinningBids" :key="bid.address">
              <td class="text-left opacity-50">{{ index + 1 }})</td>
              <td class="text-left">{{ currency.symbol }}{{ formatMicrogonsBid(bid.microgonsPerSeat) }}</td>
              <td class="text-left">{{ lastBidAtTickFromNow(bid.lastBidAtTick) }}</td>
              <td class="text-right relative">
                {{ bid.address.slice(0, 10) }}...{{ bid.address.slice(-7) }}
                <span v-if="typeof bid.subAccountIndex === 'number'" class="absolute right-0 top-1/2 -translate-y-1/2 bg-argon-600 text-white px-1.5 pb-0.25 rounded text-sm">
                  YOU
                  <span class="absolute top-0 -left-3 inline-block h-full bg-gradient-to-r from-transparent to-white w-3"></span>
                </span>
              </td>
            </tr>
            <tr v-for="i in 10 - allWinningBids.length" :key="i">
              <td class="text-left opacity-50">{{ allWinningBids.length + i }})</td>
              <td class="text-left text-gray-300 pr-2"><div class="w-full h-5 bg-gray-100"></div></td>
              <td class="text-left text-gray-300 pr-2"><div class="w-full h-5 bg-gray-100"></div></td>
              <td class="text-right text-gray-300"><div class="w-full h-5 bg-gray-100"></div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </PopoverPanel>
  </Popover>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useCurrency } from '../stores/currency';
import { getMainchainClient, getMining } from '../stores/mainchain';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import { useStats } from '../stores/stats';
import { Accountset, getRange, type IBidsFile } from '@argonprotocol/apps-core';
import { createNumeralHelpers } from '../lib/numeral';
import { TICK_MILLIS } from '../lib/Env.ts';
import { useConfig } from '../stores/config.ts';
import { useWalletKeys } from '../stores/wallets.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = withDefaults(
  defineProps<{
    loadFromMainchain?: boolean;
    position?: 'left' | 'top';
  }>(),
  {
    loadFromMainchain: false,
    position: 'top',
  },
);

const stats = useStats();
const currency = useCurrency();
const mainchain = getMining();
const walletKeys = useWalletKeys();

const panelPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[-80px] right-[calc(100%+10px)]';
  } else {
    // props.position === 'top'
    return 'top-[-55px] left-1/2 -translate-x-1/2 -translate-y-full';
  }
});

const arrowPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[62px] right-0 translate-x-[22.5px] -translate-y-full rotate-90';
  } else {
    // props.position === 'top'
    return 'top-full left-1/2 -translate-x-1/2 rotate-180';
  }
});

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const allWinningBids = Vue.computed<IBidsFile['winningBids']>(() => stats.allWinningBids);

function formatMicrogonsBid(microgonsBid: bigint | undefined): string {
  if (!microgonsBid) return '0.00';
  return microgonToMoneyNm(microgonsBid).format('0,0.00');
}

function lastBidAtTickFromNow(lastBidAtTick: number | undefined): string {
  if (!lastBidAtTick) return '---';
  return dayjs
    .utc(lastBidAtTick * TICK_MILLIS)
    .local()
    .fromNow();
}

Vue.onMounted(async () => {
  if (props.loadFromMainchain) {
    const subaccounts = await walletKeys.getMiningSubaccounts();
    const allWinningBids = await mainchain.fetchWinningBids();
    for (const bid of allWinningBids) {
      const accountInfo = subaccounts[bid.address];
      if (accountInfo) {
        bid.subAccountIndex = accountInfo.index;
      }
    }
    stats.allWinningBids = allWinningBids;
  }
});
</script>

<style scoped>
@reference "../main.css";

th,
td {
  @apply border-b border-gray-300;
}

tbody tr:last-child {
  th,
  td {
    @apply border-b-0;
  }
}
</style>
