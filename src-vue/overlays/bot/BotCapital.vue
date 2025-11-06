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
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Seat Goal</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Est. Seats</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Est. Cost</td>
                <td class="text-argon-800/40 w-5/12 text-right font-sans font-light">Est. Earnings</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Maximum Bid ({{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ seatGoalCount }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ probableMinSeats }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidSeatsCost).format('0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(maximumBidSeatsEarnings).format('0,0.00') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Starting Bid ({{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ seatGoalCount }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ probableMaxSeats }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(startingBidSeatsCost).format('0,0.00') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(startingBidSeatsEarnings).format('0,0.00') }}
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
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => config.biddingRules as IBiddingRules);

const probableMinSeats = Vue.ref(0);
const probableMaxSeats = Vue.ref(0);

const maximumBidSeatsCost = Vue.ref(0n);
const maximumBidSeatsEarnings = Vue.ref(0n);
const startingBidSeatsCost = Vue.ref(0n);
const startingBidSeatsEarnings = Vue.ref(0n);

const maximumBidAmount = Vue.ref(0n);
const startingBidAmount = Vue.ref(0n);
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

  const probableMinSeatsBn =
    calculator.maximumBidAmount > 0n
      ? BigNumber(rules.value.startingMicrogons).dividedBy(calculator.maximumBidAmount)
      : new BigNumber(0);
  probableMinSeats.value = Math.max(probableMinSeatsBn.integerValue(BigNumber.ROUND_FLOOR).toNumber(), 0);

  const probableMaxSeatsBn = BigNumber(rules.value.startingMicrogons).dividedBy(calculator.startingBidAmount);
  probableMaxSeats.value = Math.min(
    probableMaxSeatsBn.integerValue(BigNumber.ROUND_FLOOR).toNumber(),
    calculatorData.maxPossibleMiningSeatCount,
  );

  const averageEarningsPerSeat = (calculator.slowGrowthRewards + calculator.fastGrowthRewards) / 2n;

  const minSeats = BigInt(probableMinSeats.value);
  maximumBidSeatsCost.value =
    minSeats * (calculator.maximumBidAmount + currency.micronotToMicrogon(calculatorData.micronotsRequiredForBid));
  maximumBidSeatsEarnings.value = minSeats * averageEarningsPerSeat;

  const maxSeats = BigInt(probableMaxSeats.value);
  startingBidSeatsCost.value =
    maxSeats * (calculator.startingBidAmount + currency.micronotToMicrogon(calculatorData.micronotsRequiredForBid));
  startingBidSeatsEarnings.value = maxSeats * averageEarningsPerSeat;
}

Vue.onMounted(() => {
  calculatorData.load().then(() => {
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
