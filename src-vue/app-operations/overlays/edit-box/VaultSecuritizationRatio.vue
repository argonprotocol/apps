<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    Bitcoins locked in your vault are protected from theft with Argon collateral. The more collateral you commit, the safer people will feel to lock bitcoin in your vault.
  </p>

  <div class="flex flex-col w-full">
    <div class="mt-3 font-bold opacity-60 mb-0.5">
      Collateral Provided
    </div>
    <div class="flex flex-row items-center gap-2 w-full">
      <InputNumber v-model="collateralProvided" @input="updateCollateral" :min="100" :max="100" :dragBy="1" :maxDecimals="0" format="percent" class="w-1/2" />
      <div>=</div>
      <div class="border border-slate-400 rounded-md px-2 py-1 h-[32px] border-dashed w-1/2 font-mono text-sm text-gray-800">
        {{ config.vaultingRules.securitizationRatio }} to 1
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import InputNumber from '../../../components/InputNumber.vue';
import { getVaultCalculator } from '../../../stores/mainchain.ts';
import { getConfig } from '../../../stores/config.ts';

const config = getConfig();
const calculator = getVaultCalculator();

const collateralProvided = Vue.ref(config.vaultingRules.securitizationRatio * 100);

function updateCollateral(value: number) {
  config.vaultingRules.securitizationRatio = BigNumber(value).dividedBy(100).toNumber();
  calculator.updateCapitalSplit();
}
</script>
