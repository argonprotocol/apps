<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    This panel allows you to set the expected usage rates of your vault. Will the demand for Liquid Locking of Bitcoin be strong enough
    to keep your vault at capacity? Will people contribute to your treasury pool?
  </p>

  <div v-if="showBidAmountAlert" class="rounded-md bg-yellow-50 p-4">
    <div class="flex">
      <div class="shrink-0">
        <ExclamationTriangleIcon class="size-5 text-yellow-400" aria-hidden="true" />
      </div>
      <div class="ml-3">
        <h3 class="text-sm font-medium text-yellow-800">Maximum Bid Overridden</h3>
        <div class="mt-1 text-sm text-yellow-700">
          <p>Your changes to growth rate has impacted the values used in your maximum bid. You might want to adjust your maximum bid after saving this screen.</p>
        </div>
      </div>
    </div>
  </div>

  <div class="mt-3 font-bold opacity-60 mb-0.5">
    Flat Fee
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputArgon v-model="config.vaultingRules.btcFlatFee" class="w-full" />
  </div>

  <div class="mt-3 font-bold opacity-60 mb-0.5">
    Percentage Fee
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputNumber v-model="config.vaultingRules.btcPctFee" :min="0" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" class="w-full" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import InputNumber from '../../components/InputNumber.vue';
import InputArgon from '../../components/InputArgon.vue';
import { getConfig } from '../../stores/config';

const config = getConfig();
const showBidAmountAlert = Vue.ref(false);
</script>
