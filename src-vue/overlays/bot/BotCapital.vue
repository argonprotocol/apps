<template>
  <TooltipProvider :disableHoverableContent="true" :delayDuration="0">
    <TooltipRoot>
      <TooltipTrigger>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="`bottom`"
          :sideOffset="-5"
          :align="props.align ?? 'center'"
          :alignOffset="alignOffset ?? 0"
          :avoidCollisions="true"
          :collisionPadding="30"
          class="text-md data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade pointer-events-none z-100 w-[800px] rounded-lg border border-gray-800/20 bg-white px-5 pt-4 pb-2 text-left leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity]">
          <p>
            This box contains the number of tokens (both argons and argonots) that are committed to your mining
            operations. Your bidding bot will use these tokens to win mining seats on your behalf. The number of seats
            you win will vary based on how much capital you invest and how many other bidders are competing against you.
          </p>

          <p>
            You can set your Starting Bid and Maximum Bid in the config settings to give your bot a bidding range it
            must stay within.
          </p>

          <p>Below is a breakdown of your estimated seat outcomes over the next ten days.</p>

          <table class="relative z-50 mt-2 h-full w-full table-fixed whitespace-nowrap">
            <tbody>
              <tr class="text-argon-600 h-1/3">
                <td class="w-5/12"></td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Est. Seats</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">ARGN/Seat</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">ARGNOT/Seat</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Cost Total</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Earnings Total</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Maximum Bid ({{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ maximumBidProbableSeatCount }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ microgonToArgonNm(maximumBidArgonPerSeat).formatIfElse('>1000', '0,0.[00]', '0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ micronotToArgonotNm(maximumBidArgonotPerSeat).formatIfElse('>1000', '0,0.[00]', '0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidCostTotal).format('0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidEarningsTotal).format('0,0.00') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Starting Bid ({{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ startingBidProbableSeatCount }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ microgonToArgonNm(startingBidArgonPerSeat).formatIfElse('>1000', '0,0.[00]', '0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ micronotToArgonotNm(startingBidArgonotPerSeat).formatIfElse('>1000', '0,0.[00]', '0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(startingBidCostTotal).format('0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(startingBidEarningsTotal).format('0,0.00') }}
                </td>
              </tr>
            </tbody>
          </table>

          <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/50 shadow-2xl" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useCurrency } from '../../stores/currency';
import BigNumber from 'bignumber.js';
import { createNumeralHelpers } from '../../lib/numeral';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { getBiddingCalculator, getBiddingCalculatorData } from '../../stores/mainchain';
import { useConfig } from '../../stores/config';
import { IBiddingRules, SeatGoalInterval, SeatGoalType } from '@argonprotocol/apps-core';

const props = defineProps<{
  align?: 'start' | 'end' | 'center';
  alignOffset?: number;
}>();

const calculator = getBiddingCalculator();
const calculatorData = getBiddingCalculatorData();

const config = useConfig();
const currency = useCurrency();
const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => config.biddingRules as IBiddingRules);

const startingBidAmount = Vue.ref(0n);
const startingBidArgonPerSeat = Vue.ref(0n);
const startingBidArgonotPerSeat = Vue.ref(0n);
const startingBidCostPerSeat = Vue.ref(0n);
const startingBidEarningsPerSeat = Vue.ref(0n);
const startingBidProbableSeatCount = Vue.ref(0);
const startingBidCostTotal = Vue.ref(0n);
const startingBidEarningsTotal = Vue.ref(0n);

const maximumBidAmount = Vue.ref(0n);
const maximumBidArgonPerSeat = Vue.ref(0n);
const maximumBidArgonotPerSeat = Vue.ref(0n);
const maximumBidCostPerSeat = Vue.ref(0n);
const maximumBidEarningsPerSeat = Vue.ref(0n);
const maximumBidProbableSeatCount = Vue.ref(0);
const maximumBidCostTotal = Vue.ref(0n);
const maximumBidEarningsTotal = Vue.ref(0n);

const seatGoalCount = Vue.ref(rules.value.seatGoalCount);

function updateAPYs() {
  calculator.updateBiddingRules(rules.value);
  calculator.calculateBidAmounts();

  if (rules.value.seatGoalType === SeatGoalType.MinPercent || rules.value.seatGoalType === SeatGoalType.MaxPercent) {
    seatGoalCount.value = Math.floor((rules.value.seatGoalCount / 100) * calculatorData.maxPossibleMiningSeatCount);
  } else {
    seatGoalCount.value = rules.value.seatGoalCount;
    if (rules.value.seatGoalInterval === SeatGoalInterval.Frame) {
      seatGoalCount.value *= 10;
    }
  }
  maximumBidAmount.value = calculator.maximumBidAmount;
  startingBidAmount.value = calculator.startingBidAmount;

  const averageEarningsPerSeat = (calculator.slowGrowthRewards + calculator.fastGrowthRewards) / 2n;

  const startingProjections = calculator.runProjections(rules.value, 'starting');
  startingBidProbableSeatCount.value = startingProjections.estimatedSeats;
  startingBidArgonPerSeat.value = calculator.startingBidAmount;
  startingBidArgonotPerSeat.value = calculatorData.maximumMicronotsForBid;

  const startingBidSeatsCount = BigInt(startingBidProbableSeatCount.value);
  const startingBidSeatCost =
    calculator.startingBidAmount + currency.micronotToMicrogon(calculatorData.maximumMicronotsForBid);
  startingBidCostTotal.value = startingBidSeatsCount * startingBidSeatCost;
  startingBidEarningsTotal.value = startingBidSeatsCount * averageEarningsPerSeat;

  const maximumProjections = calculator.runProjections(rules.value, 'maximum');
  maximumBidProbableSeatCount.value = maximumProjections.estimatedSeats;
  maximumBidArgonPerSeat.value = calculator.maximumBidAmount;
  maximumBidArgonotPerSeat.value = calculatorData.maximumMicronotsForBid;

  const maximumBidSeatCount = BigInt(maximumBidProbableSeatCount.value);
  const maximumBidSeatCost =
    calculator.maximumBidAmount + currency.micronotToMicrogon(calculatorData.maximumMicronotsForBid);
  maximumBidCostTotal.value = maximumBidSeatCount * maximumBidSeatCost;
  maximumBidEarningsTotal.value = maximumBidSeatCount * averageEarningsPerSeat;
}

Vue.onMounted(() => {
  calculator.load().then(() => {
    updateAPYs();
  });
});

Vue.watch(
  rules,
  () => {
    updateAPYs();
  },
  { deep: true },
);
</script>

<style scoped>
@reference "../../main.css";

table td {
  @apply py-2;
}

p {
  @apply mb-4;
}
</style>
