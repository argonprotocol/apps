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
        <template v-if="wallets.totalMiningMicrogons < microgonRequirement || wallets.totalMiningMicronots < micronotRequirement">
          Your wallet needs an additional
          <template v-if="wallets.totalMiningMicrogons < microgonRequirement">
            {{ microgonToArgonNm(bigIntMax(0n, microgonRequirement-wallets.totalMiningMicrogons)).formatIfElse('=0', '0', '0,0.[00000000]') }} argons
          </template>
          <template v-if="wallets.totalMiningMicrogons < microgonRequirement && wallets.totalMiningMicronots < micronotRequirement">
            and
          </template>
          <template v-if="wallets.totalMiningMicronots < micronotRequirement">
            {{ micronotToArgonotNm(bigIntMax(0n, micronotRequirement-wallets.totalMiningMicronots)).formatIfElse('=0', '0', '0,0.00') }} argonots
          </template>
          to win mining bids.
          You'll need to<span @click="openWalletFunding" class="text-argon-600 underline cursor-pointer underline-offset-2">
            add more bidding capital,</span> or it might be possible to fix this by
            <span @click="openBiddingBudgetOverlay" class="text-argon-600 underline cursor-pointer underline-offset-2">
              modifying your Bidding Rules</span>.
        </template>

        <template v-else>
          The current auction has climbed above the Maximum Price set in your budget
          (Minimum Auction Bid: {{ currency.symbol }}{{ microgonToMoneyNm(networkMinimumBid).formatIfElse('=0', '0', '0,0.00') }}, Your Max: {{ currency.symbol }}{{ microgonToMoneyNm(myMaximumBid).formatIfElse('=0', '0', '0,0.00') }}). This means
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
import { getConfig } from '../../stores/config';
import ActiveBidsOverlayButton from '../../overlays/ActiveBidsOverlayButton.vue';
import BotHistoryOverlayButton from '../../overlays/BotHistoryOverlayButton.vue';
import basicEmitter from '../../emitters/basicEmitter';
import { getBiddingCalculator } from '../../stores/mainchain.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { bigIntMax, bigIntMin } from '@argonprotocol/apps-core';
import { getStats } from '../../stores/stats.ts';
import { WalletType } from '../../lib/Wallet.ts';

dayjs.extend(utc);

const config = getConfig();
const calculator = getBiddingCalculator();
const currency = getCurrency();
const wallets = useWallets();
const stats = getStats();

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const microgonRequirement = Vue.ref(0n);
const micronotRequirement = Vue.ref(0n);
const myMaximumBid = Vue.ref(0n);

const networkMinimumBid = Vue.computed(() => {
  return bigIntMin(...stats.allWinningBids.map(x => x.microgonsPerSeat ?? 0n));
});

function openBiddingBudgetOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

function openWalletFunding() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.mining, screen: 'receive' });
}

Vue.onMounted(async () => {
  if (!config.biddingRules) return;
  await config.isLoadedPromise;
  await stats.subscribeToActivity();

  const loadSubscription = calculator.onLoad(() => {
    const projections = calculator.runProjections(config.biddingRules, 'maximum');
    microgonRequirement.value = projections.microgonRequirement;
    micronotRequirement.value = projections.micronotRequirement;

    myMaximumBid.value = calculator.maximumBidAmount;
  });

  Vue.onUnmounted(() => {
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
