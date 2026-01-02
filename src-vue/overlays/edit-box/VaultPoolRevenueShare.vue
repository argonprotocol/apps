<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    As bitcoins lock into your vault, your ability to invest in treasury pools increase. Instead of investing your capital, you can share a portion of your profits with outside funders.
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

  <div class="flex flex-row items-end gap-2 w-full">
    <div class="flex flex-col w-1/2">
      <div class="mt-3 font-bold opacity-60 mb-0.5">
        Internal Take
      </div>
      <div class="flex flex-row items-center gap-2 w-full">
        <InputNumber v-model="internalProfitSharingPct" @input="handleInternalChange" :min="0" :max="100" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" class="w-full" />
      </div>
    </div>
    <div class="flex flex-col pb-1 opacity-30">
      /
    </div>
    <div class="flex flex-col w-1/2">
      <div class="mt-3 font-bold opacity-60 mb-0.5">
        External Take
      </div>
      <div class="flex flex-row items-center gap-2 w-full">
        <InputNumber v-model="config.vaultingRules.profitSharingPct" @input="handleExternalChange" :min="0" :max="100" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" class="w-full" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import InputNumber from '../../components/InputNumber.vue';
import { getConfig } from '../../stores/config';

const config = getConfig();
const showBidAmountAlert = Vue.ref(false);

const internalProfitSharingPct = Vue.ref(100 - config.vaultingRules.profitSharingPct);

function handleInternalChange(value: number) {
  config.vaultingRules.profitSharingPct = 100 - value;
}

function handleExternalChange(value: number) {
  internalProfitSharingPct.value = 100 - value;
}
</script>
