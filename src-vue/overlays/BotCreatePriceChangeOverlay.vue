<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-9/12 z-20">
    <template #title>
      <div class="text-2xl font-bold grow">Your Minimum Bot Commitment Has Changed</div>
    </template>

    <div class="flex flex-col items-start w-full pt-3 pb-5 px-5 gap-x-5">
      <p class="mt-2 font-light w-full">
        After the latest Argon Frame change, the minimum token requirements for operating your Mining Bot have changed.
        Based on the rules configured, your Mining Bot now needs the following tokens in order to operate.
      </p>

      <table class="w-full">
        <thead>
        <tr>
          <td>Token</td>
          <td>New Minimum</td>
          <td>Previously Required</td>
        </tr>
        </thead>
        <tbody class="selectable-text">
        <tr>
          <td>ARGN</td>
          <td>{{ microgonToArgonNm(requiredMicrogonsForGoal).format('0,0.[00000000]')}}</td>
          <td>{{ microgonToArgonNm(previousMinimumMicrogonsNeeded).format('0,0.[00000000]') }}</td>
        </tr>
        <tr>
          <td>ARGNOT</td>
          <td>{{ micronotToArgonotNm(requiredMicronotsForGoal).format('0,0.[00000000]')}}</td>
          <td>{{ micronotToArgonotNm(previousMinimumMicronotsNeeded).format('0,0.[00000000]') }}</td>
        </tr>
        </tbody>
      </table>

      <button
        @click="closeOverlay"
        class="w-full mt-8 inner-button-shadow px-4 py-2 rounded-lg focus:outline-none cursor-pointer bg-argon-600 hover:bg-argon-700 border-argon-700 text-white"
      >
        Ok
      </button>

    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../stores/config';
import { getCurrency } from '../stores/currency';
import Overlay from './Overlay.vue';
import { createNumeralHelpers } from '../lib/numeral';
import { getBiddingCalculator } from '../stores/mainchain.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';

const isOpen = Vue.ref(false);
const config = getConfig();
const currency = getCurrency();
const calculator = getBiddingCalculator();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const requiredMicrogonsForGoal = Vue.ref(0n);
const requiredMicronotsForGoal = Vue.ref(0n);

const previousMinimumMicrogonsNeeded = Vue.computed(() => config.biddingRules?.initialMicrogonRequirement ?? 0n);
const previousMinimumMicronotsNeeded = Vue.computed(() => config.biddingRules?.initialMicronotRequirement ?? 0n);

let loadSubscription: { unsubscribe: () => void } | null = null;

Vue.onMounted(async () => {
  loadSubscription = calculator.onLoad(() => {
    const projections = calculator.runProjections(config.biddingRules, 'maximum');
    console.log(
      'BotCreatePriceChangeOverlay: Recalculating minimum bot commitment due to calculator load/change',
      projections,
    );
    requiredMicrogonsForGoal.value = projections.microgonRequirement;
    requiredMicronotsForGoal.value = projections.micronotRequirement;

    const needsMoreMicrogons = projections.microgonRequirement > config.biddingRules.initialMicrogonRequirement;
    const needsMoreMicronots = projections.micronotRequirement > config.biddingRules.initialMicronotRequirement;
    const needsMoreCapital = needsMoreMicrogons || needsMoreMicronots;
    if (config.hasSavedBiddingRules && needsMoreCapital) {
      isOpen.value = true;
    }
  });
  await config.isLoadedPromise;
  await calculator.load();
});

Vue.onUnmounted(() => {
  loadSubscription?.unsubscribe();
  loadSubscription = null;
});

function closeOverlay() {
  config.biddingRules.initialMicrogonRequirement = requiredMicrogonsForGoal.value;
  config.biddingRules.initialMicronotRequirement = requiredMicronotsForGoal.value;
  if (config.biddingRules.initialCapitalCommitment) {
    const microgonCapital = requiredMicrogonsForGoal.value;
    const micronotCapital = currency.convertMicronotTo(requiredMicronotsForGoal.value, UnitOfMeasurement.Microgon);
    config.biddingRules.initialCapitalCommitment = microgonCapital + micronotCapital;
  }
  void config.saveBiddingRules();
  isOpen.value = false;
}

function onOpen() {
  isOpen.value = true;
}
</script>

<style scoped>
@reference "../main.css";

table {
  @apply text-md mt-6 font-mono;
  thead {
    @apply font-bold uppercase;
  }
  td {
    @apply border-b border-slate-400/30 py-3;
  }
}
</style>
