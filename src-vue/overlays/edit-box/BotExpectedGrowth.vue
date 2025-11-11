<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    This panel allows you to set the expected growth rates for Argon. The Growth in Argon Circulation is the rate of stablecoin
    minting beyond the protocol's minimum block rewards. All numbers are annualized.
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
    Growth In Argon Circulation
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputNumber v-model="config.biddingRules.argonCirculationGrowthPctMin" :min="0" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" suffix=" slow" class="w-1/2" />
    <span>to</span>
    <InputNumber v-model="config.biddingRules.argonCirculationGrowthPctMax" :min="config.biddingRules.argonCirculationGrowthPctMin" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" suffix=" fast" class="w-1/2" />
  </div>

  <div class="mt-3 font-bold opacity-60 mb-0.5">
    Growth In Argonot Price
  </div>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputNumber v-model="config.biddingRules.argonotPriceChangePctMin" :min="-100" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" suffix=" slow" class="w-1/2" />
    <span>to</span>
    <InputNumber v-model="config.biddingRules.argonotPriceChangePctMax" :min="config.biddingRules.argonotPriceChangePctMin" :dragBy="1" :dragByMin="0.1" :maxDecimals="1" format="percent" suffix=" fast" class="w-1/2" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import InputNumber from '../../components/InputNumber.vue';
import { getBiddingCalculator } from '../../stores/mainchain';
import { useConfig } from '../../stores/config';
import { IEditBoxChildExposed } from '../EditBoxOverlay.vue';

const config = useConfig();
const calculator = getBiddingCalculator();
const showBidAmountAlert = Vue.ref(false);

Vue.watch(
  config.biddingRules,
  () => {
    if (calculator.startingBidAmountFromExpectedGrowth || calculator.maximumBidAmountFromExpectedGrowth) {
      showBidAmountAlert.value = true;
    } else {
      showBidAmountAlert.value = false;
    }
  },
  { deep: true, immediate: true },
);

Vue.onMounted(() => {
  calculator.setPivotPoint('ExpectedGrowth');
});

Vue.onBeforeUnmount(() => {
  calculator.setPivotPoint(null);
});
defineExpose<IEditBoxChildExposed>({ isAlertShowing: showBidAmountAlert });
</script>
