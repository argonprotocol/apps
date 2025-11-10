<template>
  <TooltipProvider :disableHoverableContent="true" :delayDuration="0">
    <TooltipRoot>
      <TooltipTrigger asChild>
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
            Calculating your future return is complex since it's difficult to predict what will happen at auction. For
            example, you could win mining seats at your Starting Bid price of {{ currency.symbol
            }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }}, or at your Maximum Bid of {{ currency.symbol
            }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }}, or any price in-between.
          </p>

          <p>
            Regardless of price, each seat in today's auction is guaranteed to earn an average of
            {{ microgonToArgonNm(calculatorData.microgonsToMineThisSeat).format('0,0.00') }} argons and
            {{ micronotToArgonotNm(calculatorData.micronotsToMineThisSeat).format('0,0.00') }} argonots, which currently
            has a market value of {{ currency.symbol
            }}{{
              microgonToMoneyNm(calculatorData.microgonsToMineThisSeat + calculatorData.micronotsToMineThisSeat).format(
                '0,0.00',
              )
            }}. This provides the safety of a profit minimum.
          </p>

          <p>
            Another impact on profits is the future growth of the argon ecosystem. You can update the slow/fast ranges
            in your config to test various scenarios. For example, you currently have the Argon stablecoin set to grow
            between
            {{ numeral(rules.argonCirculationGrowthPctMin).formatIfElse('0', '0', '+0.[0]') }}% and
            {{ numeral(rules.argonCirculationGrowthPctMax).formatIfElse('0', '0', '+0.[0]') }}%.
          </p>

          <p>Below is an APY breakdown of your various return possibilities.</p>

          <table class="relative z-50 mt-2 h-full w-full table-fixed whitespace-nowrap">
            <tbody>
              <tr class="text-argon-600 h-1/3">
                <td class="w-5/12"></td>
                <td class="text-argon-800/40 w-5/12 pl-5 text-right font-sans font-light">Slow Growth</td>
                <td class="text-argon-800/40 w-5/12 pl-5 text-right font-sans font-light">Average Growth</td>
                <td class="text-argon-800/40 w-5/12 pl-5 text-right font-sans font-light">Fast Growth</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Maximum Bid ({{ currency.symbol }}{{ microgonToMoneyNm(maximumBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(maximumBidAtSlowGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(maximumBidAtMediumGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(maximumBidAtFastGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-light">
                  Starting Bid ({{ currency.symbol }}{{ microgonToMoneyNm(startingBidAmount).format('0,0.00') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(startingBidAtSlowGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(startingBidAtMediumGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ numeral(startingBidAtFastGrowthAPY).formatIfElseCapped('>=100', '0,0', '0,0.00', 999_999) }}%
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
import { useConfig } from '../../stores/config';
import { useCurrency } from '../../stores/currency';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { IBiddingRules } from '@argonprotocol/apps-core';
import { getBiddingCalculator, getBiddingCalculatorData } from '../../stores/mainchain';

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

const maximumBidAtSlowGrowthAPY = Vue.ref(0);
const maximumBidAtMediumGrowthAPY = Vue.ref(0);
const maximumBidAtFastGrowthAPY = Vue.ref(0);
const startingBidAtSlowGrowthAPY = Vue.ref(0);
const startingBidAtMediumGrowthAPY = Vue.ref(0);
const startingBidAtFastGrowthAPY = Vue.ref(0);

const maximumBidAmount = Vue.ref(0n);
const startingBidAmount = Vue.ref(0n);

function updateAPYs() {
  calculator.updateBiddingRules(rules.value);
  calculator.calculateBidAmounts();

  maximumBidAmount.value = calculator.maximumBidAmount;
  startingBidAmount.value = calculator.startingBidAmount;

  maximumBidAtSlowGrowthAPY.value = calculator.maximumBidAtSlowGrowthAPY;
  maximumBidAtMediumGrowthAPY.value =
    (Math.min(calculator.maximumBidAtSlowGrowthAPY, 999_999) +
      Math.min(calculator.maximumBidAtFastGrowthAPY, 999_999)) /
    2;
  maximumBidAtFastGrowthAPY.value = calculator.maximumBidAtFastGrowthAPY;
  startingBidAtSlowGrowthAPY.value = calculator.startingBidAtSlowGrowthAPY;
  startingBidAtMediumGrowthAPY.value =
    (Math.min(calculator.startingBidAtSlowGrowthAPY, 999_999) +
      Math.min(calculator.startingBidAtFastGrowthAPY, 999_999)) /
    2;
  startingBidAtFastGrowthAPY.value = calculator.startingBidAtFastGrowthAPY;
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
