<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    Choose how much of the Treasury Pool you want to fund with your own capital versus allowing external parties to fund it.
  </p>

  <div class="flex flex-row items-end gap-2 w-full">
    <div class="flex flex-col  w-1/2">
      <div class="mt-3 font-bold opacity-60 mb-0.5">
        Internally Funded
      </div>
      <div class="flex flex-row items-center gap-2 w-full">
        <InputNumber v-model="capitalForTreasuryPct" @input="handlePoolChange" :min="0" :max="100" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" class="w-full" />
      </div>
    </div>
    <div class="flex flex-col   w-1/2">

      <div class="mt-3 font-bold opacity-40 mb-0.5">
        Externally Funded
      </div>
      <div class="flex flex-row items-center gap-2 w-full">
        <div
          class="border-dashed min-w-20 font-mono text-sm flex flex-row w-full text-left py-[3px] border border-slate-700/50 rounded-md text-gray-800 cursor-text"
        >
          <span class="select-none pl-[10px] py-[1px] inline-block">
            {{currency.symbol}}{{ microgonToMoneyNm(externalFundingArgons).format('0,0') }}
          </span>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import InputNumber from '../../components/InputNumber.vue';
import { getVaultCalculator } from '../../stores/mainchain';
import { getConfig } from '../../stores/config';
import { getCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';

const config = getConfig();
const calculator = getVaultCalculator();
const currency = getCurrency();
const capitalForTreasuryPct = Vue.ref(calculator.calculatePercentOfTreasuryClaimed());

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const externalFundingArgons = Vue.ref(0n);

function handlePoolChange(value: number) {
  calculator.updateTreasuryFundingPercent(value);
  externalFundingArgons.value = calculator.calculateTotalPoolSpace('Full') - calculator.calculateInternalPoolCapital();
}

Vue.onUpdated(() => {
  handlePoolChange(capitalForTreasuryPct.value);
});
Vue.onMounted(async () => {
  await calculator.load(config.vaultingRules);
  handlePoolChange(capitalForTreasuryPct.value);
});
</script>
