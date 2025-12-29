<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    It's a good idea to kickstart your vault with some existing bitcoin.  It helps show people your vault is active, and
    the more bitcoin you lock, the sooner you'll start earning returns.
  </p>

  <div class="flex flex-col w-full">
    <div class="mt-3 font-bold opacity-60 mb-0.5">
      Percent of Bitcoin Space to Lock
    </div>
    <div class="flex flex-row items-center gap-2 w-full">
      <InputNumber v-model="rules.personalBtcPct" @input="updateValue" :maxDecimals="0" class="w-5/12" :min="0" :max="100" :dragBy="1" :dragByMin="0.1" format="percent"  prefix='' />
      <div>=</div>
      <div class="border border-slate-400 rounded-md px-2 py-1 h-[32px] border-dashed w-7/12 font-mono text-sm text-gray-800">
        {{ microgonToBtcNm(btcMicrogons).format('0,0[.00000000]') }} <span class="opacity-50">BTC</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getVaultCalculator } from '../../stores/mainchain';
import { getConfig } from '../../stores/config';
import { getCurrency } from '../../stores/currency';
import { createNumeralHelpers } from '../../lib/numeral';
import InputNumber from '../../components/InputNumber.vue';
import { bigNumberToBigInt } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';

const config = getConfig();
const currency = getCurrency();
const calculator = getVaultCalculator();

const { microgonToBtcNm } = createNumeralHelpers(currency);

const btcMicrogons = Vue.ref(0n);

const rules = Vue.computed(() => config.vaultingRules);

function updateValue(value: number) {
  btcMicrogons.value = bigNumberToBigInt(BigNumber(value).div(100).times(calculator.calculateBtcSpaceInMicrogons()));
}

Vue.onMounted(async () => {
  await calculator.load(rules.value);
  updateValue(rules.value.personalBtcPct);
});
</script>
