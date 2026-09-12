<template>
  <MiningStatPopover
    :open="open"
    :pinned="pinned"
    ariaLabel="View winning bid details"
    triggerTestId="BiddingBotOverlay.winningBidsStat"
    contentTestId="BiddingBotOverlay.bidsPopover"
    arrowTestId="BiddingBotOverlay.bidsPopoverArrow"
    class="group hover:bg-argon-20 flex w-1/3 cursor-pointer flex-col items-center justify-start px-5 py-4 text-center focus:outline-none"
    @preview="emit('preview')"
    @leave="emit('leave')"
    @togglePin="emit('togglePin')"
    @dismiss="emit('dismiss')"
  >
    <span class="group-hover:text-argon-600/70 text-lg font-bold text-[#a08fb7]">Winning Bids</span>
    <!-- prettier-ignore -->
    <div class="text-argon-700/80 relative my-1.5 w-full border-y border-dashed border-slate-500/30 font-mono font-bold">
      <div class="py-2 whitespace-nowrap">
        {{ winningBids.length }} Bid{{ winningBids.length === 1 ? '' : 's' }}
        <template v-if="bot.state?.lastBid">
          <span class="mx-1 text-slate-400">·</span>
          Last Bid {{ currency.symbol
          }}{{ microgonToMoneyNm(bot.state.lastBid.microgonsPerSeat).format('0.[0]a') }}/Seat
        </template>
        <template v-else-if="winningBids.length === 0">
          <span class="mx-1 text-slate-400">·</span>
          No Bid Submitted
        </template>
      </div>
    </div>
    <span class="text-md text-gray-500/60">
      <template v-if="!bot.isReady">Bot offline</template>
      <template v-else-if="bot.isSyncing">Syncing mining data</template>
      <template v-else-if="bot.state?.lastBid && !bot.state.lastBid.isFinalized">Awaiting bid finalization</template>
      <template v-else-if="bot.state?.nextBid">
        Bid planned
        <span class="mx-1 text-slate-400">·</span>
        {{ currency.symbol }}{{ microgonToMoneyNm(bot.state.nextBid.microgonsPerSeat).format('0.[0]a') }}/seat ×
        {{ bot.state.nextBid.seats }} in {{ nextBidDelay.value }} {{ nextBidDelay.shortUnit }}
      </template>
      <template v-else>No bid planned</template>
    </span>

    <template #content>
      <div class="px-4 py-3">
        <p class="font-bold">Bot's Next Action</p>
        <p v-if="bot.state?.nextBid" class="mt-1">
          Bidding {{ currency.symbol }}{{ microgonToMoneyNm(bot.state.nextBid.microgonsPerSeat).format('0,0.00') }}/seat
          for {{ bot.state.nextBid.seats }} seat{{ bot.state.nextBid.seats === 1 ? '' : 's' }} in
          {{ nextBidDelay.value }} {{ nextBidDelay.unit }}{{ nextBidDelay.value === 1 ? '' : 's' }}.
        </p>
        <p v-else-if="!bot.isReady" class="mt-1">Resume bidding when connected.</p>
        <p v-else-if="bot.isSyncing" class="mt-1">Evaluate bids after mining data updates.</p>
        <p v-else-if="bot.state?.lastBid && !bot.state.lastBid.isFinalized" class="mt-1">
          Evaluate bids after the last bid finalizes.
        </p>
        <p v-else class="mt-1">Monitor the auction. No bid is currently planned.</p>

        <div class="mt-3 border-t border-slate-200 pt-3">
          <p class="font-bold">Last Bid</p>
          <p v-if="bot.state?.lastBid" class="mt-1">
            {{ bot.state.lastBid.seats }} seats at {{ currency.symbol
            }}{{ microgonToMoneyNm(bot.state.lastBid.microgonsPerSeat).format('0,0.00') }}/seat
            <template v-if="bot.state.lastBid.isFinalized">
              · {{ bot.state.lastBid.seatsWon }} won · {{ formatTickDistance(bot.state.lastBid.submittedAtTick) }}
            </template>
            <template v-else>· awaiting finalization</template>
          </p>
          <p v-else-if="winningBids.length" class="mt-1">Last bid details are unavailable.</p>
          <p v-else class="mt-1">No bid in this auction.</p>
        </div>
      </div>
    </template>
  </MiningStatPopover>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IWinningBid } from '@argonprotocol/apps-core';
import MiningStatPopover from './MiningStatPopover.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getBot } from '../../stores/bot.ts';
import { getCurrency } from '../../stores/currency.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';

const props = defineProps<{
  open: boolean;
  pinned: boolean;
  bids: IWinningBid[];
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'leave'): void;
  (event: 'togglePin'): void;
  (event: 'dismiss'): void;
}>();

const bot = getBot();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);
const winningBids = Vue.computed(() => props.bids.filter(bid => typeof bid.subAccountIndex === 'number'));
const nextBidDelay = Vue.computed(() => {
  const ticks = Math.max((bot.state?.nextBid?.atTick ?? 0) - (bot.state?.currentTick ?? 0), 0);
  const seconds = Math.ceil((ticks * TICK_MILLIS) / 1_000);
  if (seconds < 60) return { value: seconds, unit: 'second', shortUnit: 'sec' };
  return { value: Math.ceil(seconds / 60), unit: 'minute', shortUnit: 'min' };
});

function formatTickDistance(tick: number): string {
  const elapsedTicks = Math.max((bot.state?.currentTick ?? tick) - tick, 0);
  const elapsedSeconds = Math.floor((elapsedTicks * TICK_MILLIS) / 1_000);
  if (elapsedSeconds === 0) return 'just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds} second${elapsedSeconds === 1 ? '' : 's'} ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  return `${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} ago`;
}
</script>
