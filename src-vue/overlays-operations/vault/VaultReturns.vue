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
          class="text-md data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade pointer-events-none z-100 rounded-lg border border-gray-800/20 bg-white px-5 pt-4 pb-2 text-left leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity]"
          :style="{ width: props.width }">
          <p>
            Your future returns are dependent on several factors, including the percent utilization of your Bitcoin and
            Treasury Pools. The following table projects out future returns based on the prior epoch.
          </p>

          <table class="relative z-50 mt-2 h-full w-full table-fixed whitespace-nowrap">
            <tbody>
              <tr class="text-argon-600 h-1/3">
                <td class="w-6/12"></td>
                <td class="text-argon-800/40 w-2/12 pl-5 text-right font-sans font-bold">Period</td>
                <td class="text-argon-800/40 w-2/12 pl-5 text-right font-sans font-bold">Low Usage</td>
                <td class="text-argon-800/40 w-2/12 pl-5 text-right font-sans font-bold">High Usage</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td class="text-argon-800/40 border-t border-slate-500 pr-10 pl-2 text-left font-sans font-medium">
                  Total Investment in Treasury
                </td>
                <td class="border-t border-slate-500 text-right font-light">Epoch</td>
                <td class="border-t border-slate-500 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.epochPoolCapitalTotal).format('0,0') }}
                </td>
                <td class="border-t border-slate-500 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.epochPoolCapitalTotal).format('0,0') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Total Revenue from Treasury
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-light">Epoch</td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.epochPoolRewards).format('0,0') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.epochPoolRewards).format('0,0') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td class="text-argon-800/40 border-t border-slate-500 pr-10 pl-2 text-left font-sans font-medium">
                  Vault Investment in Treasury
                </td>
                <td class="border-t border-slate-500 text-right font-light">Epoch</td>
                <td class="border-t border-slate-500 text-right">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateTotalPoolCapital('Low', 'Low')).format('0,0') }}
                </td>
                <td class="border-t border-slate-500 text-right">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateTotalPoolCapital('High', 'High')).format('0,0') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Vault Revenue from Treasury
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-light">Epoch</td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol
                  }}{{
                    microgonToMoneyNm(
                      calculator.calculateInternalRevenue('Low', 'Low') - calculator.calculateInternalBtcRevenue('Low'),
                    ).format('0,0')
                  }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol
                  }}{{
                    microgonToMoneyNm(
                      calculator.calculateInternalRevenue('High', 'High') -
                        calculator.calculateInternalBtcRevenue('High'),
                    ).format('0,0')
                  }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Vault Revenue from Bitcoin
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-light">Epoch</td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateInternalBtcRevenue('Low')).format('0,0') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateInternalBtcRevenue('High')).format('0,0') }}
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Payouts to External Treasury Funders
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-light">Epoch</td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  ({{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateExternalRevenue('Low', 'Low')).format('0,0') }})
                </td>
                <td class="border-t border-dashed border-slate-300 text-right">
                  ({{ currency.symbol
                  }}{{ microgonToMoneyNm(calculator.calculateExternalRevenue('High', 'High')).format('0,0') }})
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td class="text-argon-800/40 border-t border-slate-500 pr-10 pl-2 text-left font-sans font-medium">
                  Your Annual Percent Yield (APY)
                </td>
                <td class="border-t border-slate-500 text-right font-light"></td>
                <td class="border-t border-slate-500 text-right">
                  {{
                    numeral(calculator.calculateInternalAPY('Low', 'Low')).formatIfElseCapped(
                      '>=100',
                      '0,0',
                      '0,0.00',
                      999_999,
                    )
                  }}%
                </td>
                <td class="border-t border-slate-500 text-right">
                  {{
                    numeral(calculator.calculateInternalAPY('High', 'High')).formatIfElseCapped(
                      '>=100',
                      '0,0',
                      '0,0.00',
                      999_999,
                    )
                  }}%
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
import { getConfig } from '../../stores/config';
import { getCurrency } from '../../stores/currency';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { getVaultCalculator } from '../../stores/mainchain.ts';

const props = withDefaults(
  defineProps<{
    align?: 'start' | 'end' | 'center';
    alignOffset?: number;
    width?: string;
  }>(),
  {
    width: '700px',
  },
);

const calculator = getVaultCalculator();

const config = getConfig();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const rules = Vue.computed(() => config.vaultingRules);

const btcSpaceAvailable = Vue.ref(0n);
const poolSpace = Vue.ref(0n);

function updateAPYs() {
  btcSpaceAvailable.value = calculator.calculateBtcSpaceInMicrogons();

  poolSpace.value = calculator.calculateTotalPoolSpace('High');
}

Vue.onMounted(async () => {
  calculator.load(rules.value).then(updateAPYs);
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
