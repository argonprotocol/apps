<!-- prettier-ignore -->
<template>
  <div data-startid="FirstAuctionWinning" class="grow relative bg-white rounded border border-[#CCCEDA] shadow text-center m-3 overflow-hidden">
    <ConfettiIcon class="absolute top-[10px] left-[10px]" style="width: calc(100% - 20px)" />
    <div class="relative mx-auto inline-block">
      <h1 class="text-5xl font-bold text-center mt-24 mb-10 whitespace-nowrap relative z-0">
        <span FadeBgToWhite class="relative text-argon-600 z-20">Your First Auction Is Live!</span>
      </h1>

      <div class="text-center mb-5 uppercase text-base flex flex-row justify-center items-center">
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
        <div class="whitespace-nowrap px-5 text-gray-500">
          YOU ARE IN BID POSITION{{ bidPositions.length > 1 ? 'S' : '' }}
        </div>
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
      </div>
      <div class="flex flex-col items-center justify-center min-h-[75px] fade-in-out">
        <div v-if="bidPositions.length" :class="[priceTextSize, 'text-center text-argon-600 font-bold']">
          {{bidPositions.length == 1 ? '#' : ''}}{{
            bidPositions.slice(0, -1).join(', ') +
            (bidPositions.length > 1 ? ' & ' : '') +
            bidPositions[bidPositions.length - 1]
          }}
        </div>
        <div v-else class="text-center text-7xl text-argon-600 font-bold">--- --- --- ---</div>
      </div>
      <div class="text-center mt-6 mb-5 uppercase text-base flex flex-row justify-center items-center">
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
        <div class="whitespace-nowrap px-5 text-gray-500">
          AT A {{ bidPositions.length > 1 ? 'COMBINED' : 'TOTAL' }} PRICE OF
        </div>
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
      </div>
      <div class="flex flex-col items-center justify-center min-h-[75px] fade-in-out">
        <div v-if="bidPositions.length" :class="[priceTextSize, 'text-center text-argon-600 font-bold']">
          {{ currency.symbol }}{{ microgonToMoneyNm(stats.myMiningBids.microgonsBidTotal).format('0,0.00') }}
        </div>
        <div v-else class="text-center text-7xl text-argon-600 font-bold">{{ currency.symbol }}--.--</div>
      </div>
      <p class="text-center text-lg mt-6 border-t border-b border-gray-300 pt-8 pb-7 font-light leading-7.5">
        <template v-if="auctionIsClosing && startOfAuctionClosing != null">
          This auction is in the process of closing. Bids can still be submitted for the
          <br />
          next
          <CountdownClock
            :time="startOfAuctionClosing"
            @tick="handleAuctionClosingTick"
            v-slot="{ hours, minutes, seconds }"
          >
            <template v-if="hours">{{ hours }} hour{{ hours > 1 ? 's' : '' }}, </template>
            <template v-if="minutes">{{ minutes }} minute{{ minutes > 1 ? 's' : '' }} and </template>
            {{ seconds }} second{{ seconds > 1 ? 's' : '' }}.
          </CountdownClock>
        </template>
        <template v-else-if="startOfNextCohort != null">
          This auction will begin closing in
          <CountdownClock :time="startOfNextCohort" v-slot="{ hours, minutes, seconds }">
            <template v-if="hours">{{ hours }} hour{{ hours > 1 ? 's' : '' }}, </template>
            <template v-if="minutes">{{ minutes }} minute{{ minutes > 1 ? 's' : '' }} and </template>
            {{ seconds }} second{{ seconds > 1 ? 's' : '' }}.
          </CountdownClock>
          <br />
          Your account allows for a total bidding budget of {{ currency.symbol
          }}{{ microgonToMoneyNm(totalBiddingBudget).format('0,0.00') }}.
        </template>
      </p>
      <div class="flex flex-row justify-center items-center space-x-6 mt-10">
        <ActiveBidsOverlayButton />
        <BotHistoryOverlayButton />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useConfig } from '../../stores/config';
import { useCurrency } from '../../stores/currency';
import {
  BiddingCalculator,
  type IBiddingRules,
  BiddingCalculatorData,
  BiddingParamsHelper,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { type IWinningBid } from '@argonprotocol/apps-core';
import CountdownClock from '../../components/CountdownClock.vue';
import ConfettiIcon from '../../assets/confetti.svg?component';
import ActiveBidsOverlayButton from '../../overlays/ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from '../../overlays/BotHistoryOverlayButton.vue';
import { getMining } from '../../stores/mainchain';
import { useStats } from '../../stores/stats';
import { createNumeralHelpers } from '../../lib/numeral';
import { useWallets } from '../../stores/wallets';
import { bigIntMin } from '@argonprotocol/apps-core/src/utils';

dayjs.extend(utc);

const mainchain = getMining();

const wallets = useWallets();
const stats = useStats();
const config = useConfig();

const currency = useCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const auctionIsClosing = Vue.ref(false);

const maxPossibleBiddingBudget = Vue.ref(0n);

const totalBiddingBudget = Vue.computed(() => {
  const availableMicrogons = wallets.miningWallet.availableMicrogons + stats.myMiningBids.microgonsBidTotal;
  return bigIntMin(maxPossibleBiddingBudget.value, availableMicrogons);
});

const bidPositions = Vue.computed(() => {
  const myBids = stats.allWinningBids.filter((bid: IWinningBid) => typeof bid.subAccountIndex === 'number');
  return myBids.map((bid: IWinningBid) => (bid.bidPosition ?? 0) + 1).sort((a, b) => a - b);
});

const priceTextSize = Vue.computed(() => {
  return bidPositions.value.length > 8 ? 'text-6xl' : 'text-7xl';
});

const calculatorData = new BiddingCalculatorData(getMining());
const calculator = new BiddingCalculator(calculatorData, config.biddingRules);
const biddingParamsHelper = new BiddingParamsHelper(config.biddingRules as IBiddingRules, calculator);

const startOfAuctionClosing: Vue.Ref<dayjs.Dayjs | null> = Vue.ref(null);
const startOfNextCohort: Vue.Ref<dayjs.Dayjs | null> = Vue.ref(null);

function handleAuctionClosingTick(totalSecondsRemaining: number) {
  if (totalSecondsRemaining <= 0) {
    auctionIsClosing.value = true;
  }
}

Vue.onMounted(async () => {
  if (!config.biddingRules) return;

  await calculator.isInitializedPromise;

  if (!startOfAuctionClosing.value || !startOfNextCohort.value) {
    const tickAtStartOfAuctionClosing = await mainchain.getTickAtStartOfAuctionClosing();
    const tickAtStartOfNextCohort = await mainchain.getTickAtStartOfNextCohort();
    const tickMillis = MiningFrames.tickMillis;
    startOfAuctionClosing.value = dayjs.utc(tickAtStartOfAuctionClosing * tickMillis);
    startOfNextCohort.value = dayjs.utc(tickAtStartOfNextCohort * tickMillis);
  }

  const seatCount = await biddingParamsHelper.getMaxSeats();
  maxPossibleBiddingBudget.value = calculator.maximumBidAmount * BigInt(seatCount);
});
</script>

<style scoped>
.fade-in-out {
  animation: fadeInOut 1.5s ease-in-out infinite;
  animation-delay: 0s;
}

@keyframes fadeInOut {
  0% {
    opacity: 0.1;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.1;
  }
}
</style>

<style scoped>
@reference "../../main.css";

[FadeBgToWhite] {
  @apply relative bg-white;
  &:before {
    @apply absolute top-0 right-0 left-0 z-[-1] h-full -translate-y-full bg-gradient-to-b from-transparent to-white;
    content: '';
  }
}
table {
  thead th {
    @apply pb-2;
  }
  td {
    @apply border-t border-gray-300 align-middle;
    &:first-child {
      @apply opacity-50;
    }
  }
}
</style>
