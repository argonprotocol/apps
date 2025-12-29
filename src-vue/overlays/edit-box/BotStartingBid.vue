<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    This is your bot's minimum bid. Don't put it too low or you'll pay unneeded rebidding fees, but if you're too high, you might overpay.
  </p>

  <div v-if="showHasOverrideAlert" class="rounded-md bg-yellow-50 p-4">
    <div class="flex">
      <div class="shrink-0">
        <ExclamationTriangleIcon class="size-5 text-yellow-400" aria-hidden="true" />
      </div>
      <div class="ml-3" v-if="calculator.startingBidAmountFromMaximumBid">
        <h3 class="text-sm font-medium text-yellow-800">Maximum Bid Overridden</h3>
        <div class="mt-1 text-sm text-yellow-700">
          <p>Your changes to starting bid are conflicting with the values used in your maximum bid. You might want to adjust your maximum bid after saving this screen.</p>
        </div>
      </div>
      <div class="ml-3" v-else>
        <h3 class="text-sm font-medium text-yellow-800">This Formula Has Changed By -{{currency.symbol}}{{ microgonToMoneyNm(formulaChangeAmount).format('0,0.00') }}</h3>
        <div class="mt-1 text-sm text-yellow-700">
          <p>You made changes to the Ecosystem Growth rates, which increased the value of the formula for Starting Bid
            (Breakeven at Slow Growth). Applying this change will affect your APY.</p>
          <button @click="applyChanges" class="text-sm text-yellow-700 font-bold px-5 py-1 border border-red-500 cursor-pointer rounded-md bg-red-100 hover:bg-red-200 mt-3 mb-2 inner-button-shadow">Apply Changes</button>
        </div>
      </div>
    </div>
  </div>


  <div :class="showHasOverrideAlert ? 'opacity-50 pointer-events-none' : ''" class="flex flex-col grow">
    <label class="font-bold opacity-60 mb-0.5">
      Formula Type
    </label>
    <div v-if="options.length" class="flex flex-row items-center justify-between">
      <InputMenu data-testid="startingBidFormulaType" v-model="config.biddingRules.startingBidFormulaType" :options="options" :selectFirst="true" class="w-full" />
    </div>

    <template v-if="config.biddingRules.startingBidFormulaType === BidAmountFormulaType.Custom">
      <div class="mt-3 font-bold opacity-60 mb-0.5">
        Value
      </div>
      <InputArgon data-testid="startingBidCustomAmount" v-model="config.biddingRules.startingBidCustom" :min="0n" class="min-w-60" />
    </template>
    <div v-else>
      <label class="mt-3 font-bold opacity-60 mb-0.5">
        Additional Adjustment
      </label>
      <div v-if="options.length" class="flex flex-row items-center justify-between space-x-2">
        <InputMenu v-model="config.biddingRules.startingBidAdjustmentType" :options="[
          { name: BidAmountAdjustmentType.Absolute, value: BidAmountAdjustmentType.Absolute },
          { name: BidAmountAdjustmentType.Relative, value: BidAmountAdjustmentType.Relative }
        ]" :selectFirst="true" class="w-1/3" />
        <InputArgon v-if="isAbsoluteType" v-model="config.biddingRules.startingBidAdjustAbsolute" class="w-1/3" />
        <InputNumber v-else v-model="config.biddingRules.startingBidAdjustRelative" :min="-100" :dragBy="0.01" format="percent" class="w-1/3" />
        <div> = </div>
        <div class="border border-slate-400 rounded-md px-2 py-1 h-[32px] border-dashed w-1/3 font-mono text-sm text-gray-800">
          {{ currency.symbol }}{{ microgonToMoneyNm(calculator.startingBidAmount).format('0,0.00') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { BidAmountAdjustmentType, BidAmountFormulaType } from '@argonprotocol/apps-core';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import InputMenu, { type IOption } from '../../components/InputMenu.vue';
import InputNumber from '../../components/InputNumber.vue';
import InputArgon from '../../components/InputArgon.vue';
import { getBiddingCalculator } from '../../stores/mainchain';
import { getConfig } from '../../stores/config';
import { getCurrency } from '../../stores/currency';
import { createNumeralHelpers } from '../../lib/numeral';
import { emit } from '@tauri-apps/api/event';
import { IEditBoxChildExposed } from '../EditBoxOverlay.vue';

const config = getConfig();
const calculator = getBiddingCalculator();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const options = Vue.ref<IOption[]>([]);
const formulaChangeAmount = Vue.ref<bigint>(0n);

const showHasOverrideAlert = Vue.ref(false);
const startingBidAmountFromExpectedGrowth = calculator.startingBidAmountFromExpectedGrowth;
const startingBidAmountFromMaximumBid = calculator.startingBidAmountFromMaximumBid;

function applyChanges() {
  calculator.startingBidAmountFromMaximumBid = null;
  calculator.startingBidAmountFromExpectedGrowth = null;
  emit('update:data');
  calculateOverrideAlert();
}

function beforeSave() {}

function beforeCancel() {
  calculator.startingBidAmountFromMaximumBid = startingBidAmountFromMaximumBid;
  calculator.startingBidAmountFromExpectedGrowth = startingBidAmountFromExpectedGrowth;
  calculateOverrideAlert();
}

function calculateOverrideAlert() {
  formulaChangeAmount.value =
    calculator.startingBidAmount - (calculator.startingBidAmountOverride || calculator.startingBidAmount);
  if (calculator.startingBidAmountOverride) {
    showHasOverrideAlert.value = true;
  } else {
    showHasOverrideAlert.value = false;
  }
}

const isAbsoluteType = Vue.computed(
  () => config.biddingRules.startingBidAdjustmentType === BidAmountAdjustmentType.Absolute,
);

Vue.watch(config.biddingRules, () => calculateOverrideAlert(), { deep: true, immediate: true });

Vue.onBeforeMount(async () => {
  await calculator.load();
  calculator.setPivotPoint('StartingBid');
  console.log({
    growth: startingBidAmountFromExpectedGrowth,
    max: startingBidAmountFromMaximumBid,
    override: calculator.startingBidAmountOverride,
  });
  options.value = [
    {
      name: 'Previous Day High',
      value: BidAmountFormulaType.PreviousDayHigh,
      microgons: calculator.data.previousDayHighBid,
    },
    {
      name: 'Previous Day Average',
      value: BidAmountFormulaType.PreviousDayMid,
      microgons: calculator.data.previousDayMidBid,
    },
    {
      name: 'Previous Day Low',
      value: BidAmountFormulaType.PreviousDayLow,
      microgons: calculator.data.previousDayLowBid,
    },
    {
      name: 'Breakeven at Slow Growth',
      value: BidAmountFormulaType.BreakevenAtSlowGrowth,
      microgons: calculator.breakevenBidAtSlowGrowth,
    },
    {
      name: 'Breakeven at Medium Growth',
      value: BidAmountFormulaType.BreakevenAtMediumGrowth,
      microgons: calculator.breakevenBidAtMediumGrowth,
    },
    {
      name: 'Breakeven at Fast Growth',
      value: BidAmountFormulaType.BreakevenAtFastGrowth,
      microgons: calculator.breakevenBidAtFastGrowth,
    },
    { name: 'Custom Amount', value: BidAmountFormulaType.Custom },
  ];
});

Vue.onBeforeUnmount(() => {
  calculator.setPivotPoint(null);
});
// Expose functions that can be called from parent component
defineExpose<IEditBoxChildExposed>({ beforeSave, beforeCancel, isAlertShowing: showHasOverrideAlert });
</script>
