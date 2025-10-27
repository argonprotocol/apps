<!-- prettier-ignore -->
<template>
  <div data-testid="FirstAuctionStarting" class="grow relative bg-white rounded border border-[#CCCEDA] shadow text-center m-3 overflow-hidden">
    <ConfettiIcon class="absolute top-[10px] left-[10px]" style="width: calc(100% - 20px)" />
    <div class="relative mx-auto block w-6/10">
      <h1 class="text-6xl font-bold text-argon-600 text-center mt-28 mb-10 whitespace-nowrap">YOUR BIDDING BOT</h1>

      <div class="text-center mt-6 mb-5 uppercase text-base flex flex-row justify-center items-center">
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
        <div class="whitespace-nowrap px-5 text-gray-500">IS SUBMITTING ITS</div>
        <div class="h-[1px] bg-gray-300 w-1/2"></div>
      </div>
      <div class="flex flex-col items-center justify-center min-h-[75px] fade-in-out">
        <div class="text-6xl text-center text-argon-600 font-bold">FIRST-EVER MINING BID</div>
      </div>
      <p class="text-center text-lg mt-6 border-t border-b border-gray-300 pt-8 pb-7 font-light leading-7.5 inline-block">
        Your bidding bot has successfully connected. It's now trying to win
        {{ maxSeatCount }} mining seat{{ maxSeatCount === 1 ? '' : 's' }} with a
        <span @click="openBiddingBudgetOverlay" class="text-argon-600 underline cursor-pointer underline-offset-2">
          budget cap of {{ currency.symbol }}{{ microgonToMoneyNm(maxBidPerSeat).format('0,0.[00]') }} per seat
        </span>
        .
        <template v-if="auctionIsClosing && startOfAuctionClosing">
          The currently active auction is in the process of closing. Bids can still be submitted for the next
          <div class="font-bold py-5 text-2xl opacity-70">
            <CountdownClock
              :time="startOfAuctionClosing"
              @tick="handleAuctionClosingTick"
              v-slot="{ hours, minutes, seconds }"
            >
              <template v-if="hours">{{ hours }} hour{{ hours > 1 ? 's' : '' }},&nbsp;</template>
              <template v-if="minutes">{{ minutes }} minute{{ minutes > 1 ? 's' : '' }} and</template>
              {{ seconds }} second{{ seconds > 1 ? 's' : '' }}
            </CountdownClock>
          </div>
        </template>
        <template v-else-if="startOfNextCohort">
          The current auction will begin closing in
          <div class="font-bold py-5 text-2xl opacity-70">
            <CountdownClock :time="startOfNextCohort" v-slot="{ hours, minutes, seconds }">
              <template v-if="hours">{{ hours }} hour{{ hours > 1 ? 's' : '' }},&nbsp;</template>
              <template v-if="minutes">{{ minutes }} minute{{ minutes > 1 ? 's' : '' }} and</template>
              {{ seconds }} second{{ seconds > 1 ? 's' : '' }}
            </CountdownClock>
          </div>
        </template>
        This page will update automatically when a successful bid is confirmed.
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
import CountdownClock from '../../components/CountdownClock.vue';
import ConfettiIcon from '../../assets/confetti.svg?component';
import ActiveBidsOverlayButton from '../../overlays/ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from '../../overlays/BotHistoryOverlayButton.vue';
import {
  BiddingCalculator,
  type IBiddingRules,
  BiddingCalculatorData,
  BiddingParamsHelper,
  MiningFrames,
} from '@argonprotocol/apps-core';
import basicEmitter from '../../emitters/basicEmitter';
import { getBiddingCalculator, getMining } from '../../stores/mainchain';
import { useCurrency } from '../../stores/currency';
import { useStats } from '../../stores/stats';
import { createNumeralHelpers } from '../../lib/numeral';

dayjs.extend(utc);

const mainchain = getMining();
const config = useConfig();
const currency = useCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const auctionIsClosing = Vue.ref(false);
const startOfAuctionClosing: Vue.Ref<dayjs.Dayjs | null> = Vue.ref(null);
const startOfNextCohort: Vue.Ref<dayjs.Dayjs | null> = Vue.ref(null);
const maxSeatCount = Vue.ref(0);

const calculator = getBiddingCalculator();
const biddingParamsHelper = new BiddingParamsHelper(config.biddingRules as IBiddingRules, calculator);

const maxBidPerSeat = Vue.ref(0n);

function handleAuctionClosingTick(totalSecondsRemaining: number) {
  if (totalSecondsRemaining <= 0) {
    auctionIsClosing.value = true;
  }
}

function openBiddingBudgetOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

Vue.onMounted(async () => {
  if (!config.biddingRules) return;

  await calculator.load();
  maxSeatCount.value = await biddingParamsHelper.getMaxSeats();
  maxBidPerSeat.value = calculator.maximumBidAmount;

  if (!startOfAuctionClosing.value || !startOfNextCohort.value) {
    const tickAtStartOfAuctionClosing = await mainchain.getTickAtStartOfAuctionClosing();
    const tickAtStartOfNextCohort = await mainchain.getTickAtStartOfNextCohort();
    const tickMillis = MiningFrames.tickMillis;
    startOfAuctionClosing.value = dayjs.utc(tickAtStartOfAuctionClosing * tickMillis);
    startOfNextCohort.value = dayjs.utc(tickAtStartOfNextCohort * tickMillis);
  }
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
