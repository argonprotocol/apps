<!-- prettier-ignore -->
<template>
  <PopoverRoot as="div">
    <PopoverTrigger type="button" class="inline-flex appearance-none bg-transparent p-0 text-left focus:outline-none">
      <slot>
        <span class="cursor-pointer border border-argon-300 text-center text-lg font-bold mt-10 whitespace-nowrap text-argon-600 px-7 py-2 rounded hover:bg-argon-50/40 hover:border-argon-600 transition-all duration-300">
          View Active Bids
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        as="div"
        :side="popoverSide"
        align="center"
        :sideOffset="10"
        :collisionPadding="24"
        :avoidCollisions="true"
        :style="floatingZIndex"
        class="group relative h-120 w-160 rounded-lg border border-gray-300 bg-white text-center text-lg font-bold shadow-lg"
      >
        <PopoverPanelArrow />
        <div class="h-full px-6 pt-5 pb-3 text-base text-center">
          <table class="h-full w-full">
            <thead class="font-bold">
              <tr>
                <th class="pb-2 text-left">#</th>
                <th class="pb-2 text-left">Amount</th>
                <th class="pb-2 text-left">Bid Submitted</th>
                <th class="pb-2 text-right">Bidding Account</th>
              </tr>
            </thead>
            <tbody class="font-mono font-light">
              <tr v-for="(bid, index) in allWinningBids" :key="bid.address">
                <td class="text-left opacity-50">{{ index + 1 }})</td>
                <td class="text-left">{{ currency.symbol }}{{ formatMicrogonsBid(bid.microgonsPerSeat) }}</td>
                <td class="text-left">{{ lastBidAtTickFromNow(bid.lastBidAtTick) }}</td>
                <td class="relative text-right">
                  {{ bid.address.slice(0, 10) }}...{{ bid.address.slice(-7) }}
                  <span v-if="typeof bid.subAccountIndex === 'number'" class="absolute top-1/2 right-0 -translate-y-1/2 rounded bg-argon-600 px-1.5 pb-0.25 text-sm text-white">
                    YOU
                    <span class="absolute top-0 -left-3 inline-block h-full w-3 bg-gradient-to-r from-transparent to-white"></span>
                  </span>
                </td>
              </tr>
              <tr v-for="i in 10 - allWinningBids.length" :key="i">
                <td class="text-left opacity-50">{{ allWinningBids.length + i }})</td>
                <td class="pr-2 text-left text-gray-300"><div class="h-5 w-full bg-gray-100"></div></td>
                <td class="pr-2 text-left text-gray-300"><div class="h-5 w-full bg-gray-100"></div></td>
                <td class="text-right text-gray-300"><div class="h-5 w-full bg-gray-100"></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { getStats } from '../stores/stats.ts';
import { type IBidsFile, Mining } from '@argonprotocol/apps-core';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { TICK_MILLIS } from '../lib/Env.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import PopoverPanelArrow from '../components/PopoverPanelArrow.vue';
import { useFloatingZIndex } from './helpers/OverlayZIndex.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = withDefaults(
  defineProps<{
    loadFromMainchain?: boolean;
    position?: 'left' | 'right' | 'top';
  }>(),
  {
    loadFromMainchain: false,
    position: 'top',
  },
);

const stats = getStats();
const currency = getCurrency();
const walletKeys = getWalletKeys();
const floatingZIndex = useFloatingZIndex();

const popoverSide = Vue.computed(() => {
  if (props.position === 'left') {
    return 'left';
  }

  return props.position === 'right' ? 'right' : 'top';
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
    const subaccounts = await walletKeys.getMiningBotSubaccounts();
    const client = await getMainchainClient(false);
    const allWinningBids = await Mining.fetchWinningBids(client);
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
