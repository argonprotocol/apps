<template>
  <MiningStatPopover
    :open="open"
    :pinned="pinned"
    ariaLabel="View seat capacity details"
    triggerTestId="BiddingBotOverlay.maxSeatsStat"
    contentTestId="BiddingBotOverlay.seatsPopover"
    arrowTestId="BiddingBotOverlay.seatsPopoverArrow"
    class="group hover:bg-argon-20 flex w-1/3 cursor-pointer flex-col items-center justify-start px-5 py-4 text-center focus:outline-none"
    @preview="emit('preview')"
    @leave="emit('leave')"
    @togglePin="emit('togglePin')"
    @dismiss="emit('dismiss')"
  >
    <span class="group-hover:text-argon-600/70 text-lg font-bold text-[#a08fb7]">Seat Capacity</span>
    <!-- prettier-ignore -->
    <div class="text-argon-700/80 relative my-1.5 w-full border-y border-dashed border-slate-500/30 font-mono font-bold">
      <div class="py-2 whitespace-nowrap">
        {{ bot.state?.maxSeatsInPlay ?? 0 }} Seats
        <span class="mx-1 text-slate-400">·</span>
        <template v-if="maximumBidMicrogonsPerSeat !== undefined">
          {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidMicrogonsPerSeat).format('0.[0]a') }}
        </template>
        <template v-else>—</template>
        Max Bid
      </div>
    </div>
    <span class="text-md text-gray-500/60">
      <template v-if="!bot.isReady">Capacity unavailable</template>
      <template v-else-if="bot.isSyncing">Updating capacity</template>
      <template v-else-if="bot.state?.maxSeatsReductionReason === 'max-bid-too-low'">
        Raise Maximum Bid in Settings
      </template>
      <template v-else-if="bot.state?.maxSeatsReductionReason === 'insufficient-argon-balance'">
        Add ARGN to bot capital
      </template>
      <template v-else-if="bot.state?.maxSeatsReductionReason === 'insufficient-argonot-balance'">
        Add ARGNOT to bot capital
      </template>
      <template v-else-if="bot.state?.maxSeatsInPlay === 0">No seat capacity</template>
      <template v-else>Fully funded</template>
    </span>

    <template #content>
      <div class="px-4 py-3">
        <p class="font-bold">Current capacity</p>
        <p v-if="!bot.isReady" class="mt-1">Capacity is unavailable until the bot reconnects.</p>
        <p v-else-if="bot.isSyncing" class="mt-1">Capacity will be recalculated when mining data is current.</p>
        <template v-else-if="bot.state?.maxSeatsReductionReason === 'max-bid-too-low'">
          <p class="mt-1">
            Winning another seat currently requires more than your
            <template v-if="maximumBidMicrogonsPerSeat !== undefined">
              {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidMicrogonsPerSeat).format('0,0.[00]') }}
            </template>
            Maximum Bid.
          </p>
          <p class="mt-1">
            <button
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer underline underline-offset-2"
              @click.stop="emit('openSettings')"
            >
              Open Bot Settings
            </button>
            to raise it, or wait for prices to fall.
          </p>
        </template>
        <template v-else-if="bot.state?.maxSeatsReductionReason === 'insufficient-argon-balance'">
          <p v-if="bot.state.maxSeatsInPlay === 0" class="mt-1">Bot ARGN currently funds no seats.</p>
          <p v-else class="mt-1">Bot ARGN currently funds up to {{ bot.state.maxSeatsInPlay }} seats.</p>
          <p class="mt-1">
            <button
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer underline underline-offset-2"
              @click.stop="emit('manageCapital')"
            >
              Change bot capital
            </button>
            to support more.
          </p>
        </template>
        <template v-else-if="bot.state?.maxSeatsReductionReason === 'insufficient-argonot-balance'">
          <p v-if="bot.state.maxSeatsInPlay === 0" class="mt-1">Bot ARGNOT currently supports no seats.</p>
          <p v-else class="mt-1">Bot ARGNOT currently supports up to {{ bot.state.maxSeatsInPlay }} seats.</p>
          <p class="mt-1">
            <button
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer underline underline-offset-2"
              @click.stop="emit('manageCapital')"
            >
              Change bot capital
            </button>
            to support more.
          </p>
        </template>
        <p v-else-if="bot.state?.maxSeatsInPlay === 0" class="mt-1">Bot capital currently supports no seats.</p>
        <p v-else class="mt-1">Bot capital can support all {{ bot.state?.maxSeatsInPlay ?? 0 }} seats.</p>

        <div
          v-if="bot.isReady && !bot.isSyncing && currentAuctionMicronotsPerSeat > 0n"
          class="mt-3 border-t border-slate-200 pt-3"
        >
          <p class="font-bold">Current Auction</p>
          <p class="mt-1">
            {{ currentAuctionSeatCount }} seats
            <span class="mx-1 text-slate-400">·</span>
            {{ micronotToArgonotNm(currentAuctionMicronotsPerSeat).format('0,0.00') }} ARGNOT/seat
          </p>
        </div>
      </div>
    </template>
  </MiningStatPopover>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import MiningStatPopover from './MiningStatPopover.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getBot } from '../../stores/bot.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBiddingCalculator, getBiddingCalculatorData } from '../../stores/mainchain.ts';

defineProps<{
  open: boolean;
  pinned: boolean;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'leave'): void;
  (event: 'togglePin'): void;
  (event: 'dismiss'): void;
  (event: 'manageCapital'): void;
  (event: 'openSettings'): void;
}>();

const bot = getBot();
const currency = getCurrency();
const biddingCalculator = getBiddingCalculator();
const biddingCalculatorData = getBiddingCalculatorData();
const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const clientMaximumBidMicrogonsPerSeat = Vue.ref<bigint | undefined>(
  biddingCalculator.maximumBidAmountOverride ?? biddingCalculator.maximumBidAmount,
);
const clientAuctionSeatCount = Vue.ref(biddingCalculatorData.nextCohortSize);
const clientAuctionMicronotsPerSeat = Vue.ref(biddingCalculatorData.currentMicronotsForBid);
const maximumBidMicrogonsPerSeat = Vue.computed(
  () => (bot.isReady ? bot.state?.maximumBidMicrogonsPerSeat : undefined) ?? clientMaximumBidMicrogonsPerSeat.value,
);
const currentAuctionSeatCount = Vue.computed(
  () => (bot.isReady ? bot.state?.currentAuctionSeatCount : undefined) ?? clientAuctionSeatCount.value,
);
const currentAuctionMicronotsPerSeat = Vue.computed(
  () => (bot.isReady ? bot.state?.currentAuctionMicronotsPerSeat : undefined) ?? clientAuctionMicronotsPerSeat.value,
);
let calculatorLoadSubscription: { unsubscribe: () => void } | undefined;

Vue.onMounted(() => {
  calculatorLoadSubscription = biddingCalculator.onLoad(() => {
    clientMaximumBidMicrogonsPerSeat.value =
      biddingCalculator.maximumBidAmountOverride ?? biddingCalculator.maximumBidAmount;
    clientAuctionSeatCount.value = biddingCalculatorData.nextCohortSize;
    clientAuctionMicronotsPerSeat.value = biddingCalculatorData.currentMicronotsForBid;
  });
});

Vue.onUnmounted(() => calculatorLoadSubscription?.unsubscribe());
</script>
