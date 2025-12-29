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
          <p class="leading-5">
            As the box above shows, you're committing {{ currency.symbol
            }}{{ microgonToMoneyNm(rules.baseMicrogonCommitment).format('0,0') }} to this Vault. The capital is used
            both as collateral for Liquid Locked Bitcoins, and to invest in Treasury Pools. The settings on this page
            allow you to configure the percent allocations.
          </p>

          <p class="leading-5">
            The table below shows how your capital is allocated within the vault. You'll notice the vault leverages your
            {{ currency.symbol }}{{ microgonToMoneyNm(rules.baseMicrogonCommitment).format('0,0') }} into a larger
            ecosystem value.
          </p>

          <table class="relative z-50 h-full w-full table-fixed whitespace-nowrap">
            <tbody>
              <tr class="text-argon-600">
                <td class="w-4/12"></td>
                <td class="text-argon-800/40 w-3/12 text-center font-sans font-bold">Allowed</td>
                <td class="text-argon-800/40 w-2/12 text-right font-sans font-bold">You</td>
                <td class="text-argon-800/40 w-1/12 text-center font-sans font-bold">vs</td>
                <td class="text-argon-800/40 w-1/12 text-left font-sans font-bold">Others</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td class="text-argon-800/40 border-t border-slate-500 pr-10 pl-2 text-left font-sans font-medium">
                  Argons for Bitcoin Security
                </td>
                <td class="border-t border-slate-500 text-center font-bold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.calculateSecuritization()).format('0,0') }}
                </td>
                <td class="border-t border-slate-500 text-right font-medium">100%</td>
                <td class="border-t border-slate-500 text-center font-light">vs</td>
                <td class="border-t border-slate-500 text-left font-medium">0%</td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Treasury Investment Space
                </td>
                <td class="border-t border-dashed border-slate-300 text-center font-bold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(poolSpace).format('0,0') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-medium">
                  {{ calculator.calculatePercentOfTreasuryClaimed() }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-center font-light">vs</td>
                <td class="border-t border-dashed border-slate-300 text-left font-medium">
                  {{ 100 - calculator.calculatePercentOfTreasuryClaimed() }}%
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td
                  class="text-argon-800/40 border-t border-dashed border-slate-300 pr-10 pl-2 text-left font-sans font-medium">
                  Bitcoin Locking Space
                </td>
                <td class="border-t border-dashed border-slate-300 text-center font-bold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(calculator.calculateBtcSpaceInMicrogons()).format('0,0') }}
                </td>
                <td class="border-t border-dashed border-slate-300 text-right font-medium">
                  {{ rules.personalBtcPct }}%
                </td>
                <td class="border-t border-dashed border-slate-300 text-center font-light">vs</td>
                <td class="border-t border-dashed border-slate-300 text-left font-medium">
                  {{ 100 - rules.personalBtcPct }}%
                </td>
              </tr>
              <tr class="text-argon-600 h-1/3 font-mono font-bold">
                <td class="text-argon-800/40 border-y border-slate-500 pr-10 pl-2 text-left font-sans font-medium">
                  Total
                </td>
                <td class="border-y border-slate-500 text-center font-bold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(createdValueMicrogons).format('0,0') }}
                </td>
                <td class="border-y border-slate-500 text-right font-bold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(personalCommitmentValueMicrogons).format('0,0') }}
                  <sup v-if="rules.personalBtcPct > 0" class="-ml-2 text-xs">*</sup>
                </td>
                <td class="border-y border-slate-500 text-center font-medium" colspan="2">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(createdValueMicrogons - personalCommitmentValueMicrogons).format('0,0') }}
                </td>
              </tr>
            </tbody>
          </table>

          <div class="mt-2 mb-1 flex flex-row p-2 text-sm text-slate-500">
            <template v-if="rules.personalBtcPct > 0">
              <div class="mb-2 pr-1">*</div>
              <div class="">
                This line item is including the market value of your locked Bitcoins, which is separate from the
                {{ currency.symbol }}{{ microgonToMoneyNm(rules.baseMicrogonCommitment).format('0,0') }} you're
                committing to vault operations.
              </div>
            </template>
          </div>

          <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/50 shadow-2xl" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { getVaultCalculator } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';

const props = withDefaults(
  defineProps<{
    align?: 'start' | 'end' | 'center';
    alignOffset?: number;
    width?: string;
    fromOverlay?: boolean;
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
const internalPoolCapital = Vue.ref(0n);
const securitization = Vue.ref(0n);
const createdValueMicrogons = Vue.computed(() => {
  return btcSpaceAvailable.value + poolSpace.value + securitization.value;
});

const personalCommitmentValueMicrogons = Vue.computed(() => {
  return calculator.calculateInternalPoolCapital() + securitization.value + calculator.personalBtcInMicrogons();
});

function updateAPYs() {
  btcSpaceAvailable.value = calculator.calculateBtcSpaceInMicrogons();
  securitization.value = calculator.calculateSecuritization();

  poolSpace.value = calculator.calculateTotalPoolSpace('Full');
  internalPoolCapital.value = calculator.calculateInternalPoolCapital();
}

Vue.onMounted(() => {
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
