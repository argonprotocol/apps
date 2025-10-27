<!-- prettier-ignore -->
<template>
  <div class="grow relative bg-white rounded border border-[#CCCEDA] shadow text-center m-3">
    <div class="relative mx-auto inline-block w-6/10">
      <div class="text-5xl font-bold text-gray-600 text-center mt-32 mb-4 whitespace-nowrap border-t border-gray-300 pt-16">
        YOUR BIDDING BOT
      </div>
      <div class="flex flex-col items-center justify-center min-h-[75px]">
        <div class="text-7xl text-center text-gray-600 font-bold whitespace-nowrap">FAILED TO WIN A BID</div>
      </div>
      <p class="text-center text-lg mt-10 border-t border-b border-gray-300 pt-8 pb-7 font-light leading-7.5 inline-block">
        <template v-if="wallets.totalMiningMicrogons < minimumMicrogonsForGoal || wallets.totalMiningMicronots < minimumMicronotsForGoal">
          Your wallet needs an additional
          {{currency.symbol}}{{ microgonToMoneyNm(bigIntMax(0n, minimumMicrogonsForGoal-wallets.totalMiningMicrogons)).formatIfElse('=0', '0', '0,0.00') }} argons
          and {{currency.symbol}}{{ microgonToMoneyNm(bigIntMax(0n, minimumMicronotsForGoal-wallets.totalMiningMicronots)).formatIfElse('=0', '0', '0,0.00') }} argonots
          to win mining bids with your configuration.
          <span @click="openWalletFunding" class="text-argon-600 underline cursor-pointer underline-offset-2">
            Add more funds to your wallet</span>
          if you wish to resume.
        </template>

        <template v-else>
          The current auction has climbed above the Maximum Price set in your budget
          (Minimum Bid: {{ currency.symbol }}{{ microgonToMoneyNm(minimumBidMicrogons).formatIfElse('=0', '0', '0,0.00') }}, Your Max: {{ currency.symbol }}{{ microgonToMoneyNm(myMaxMicrogonBid).formatIfElse('=0', '0', '0,0.00') }})). This means
          your bot can no longer bid.
          <span @click="openBiddingBudgetOverlay" class="text-argon-600 underline cursor-pointer underline-offset-2">
          Modify your Bidding Rules</span>
          if you wish to resume.
        </template>
      </p>
      <div class="flex flex-row justify-center items-center space-x-6 mt-14">
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
import ActiveBidsOverlayButton from '../../overlays/ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from '../../overlays/BotHistoryOverlayButton.vue';
import basicEmitter from '../../emitters/basicEmitter';
import { getBiddingCalculator, getMainchainClients } from '../../stores/mainchain.ts';
import { useWallets } from '../../stores/wallets.ts';
import { useCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { bigIntMax, bigIntMin } from '@argonprotocol/apps-core';
import { useStats } from '../../stores/stats.ts';

dayjs.extend(utc);

const config = useConfig();
const calculator = getBiddingCalculator();
const currency = useCurrency();
const wallets = useWallets();
const stats = useStats();

const { microgonToMoneyNm } = createNumeralHelpers(currency);
const minimumMicrogonsForGoal = Vue.ref(0n);
const minimumMicronotsForGoal = Vue.ref(0n);
const myMaxMicrogonBid = Vue.ref(0n);

const minimumBidMicrogons = Vue.computed(() => {
  return bigIntMin(...stats.allWinningBids.map(x => x.microgonsPerSeat ?? 0n));
});

function openBiddingBudgetOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

function openWalletFunding() {
  basicEmitter.emit('openWalletOverlay', { walletId: 'mining', screen: 'receive' });
}

Vue.onMounted(async () => {
  if (!config.biddingRules) return;
  await config.isLoadedPromise;
  await stats.subscribeToActivity();

  const loadSubscription = calculator.onLoad(() => {
    const minimumCapitalRequirement = calculator.minimumCapitalRequirement(config.biddingRules);
    minimumMicrogonsForGoal.value = minimumCapitalRequirement.startingMicrogons;
    minimumMicronotsForGoal.value = minimumCapitalRequirement.micronots;
    myMaxMicrogonBid.value = minimumCapitalRequirement.maxMicrogons;
  });

  Vue.onMounted(() => {
    loadSubscription.unsubscribe();
    stats.unsubscribeFromActivity();
  });

  await calculator.load();
});
</script>

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
