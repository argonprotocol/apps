<!-- prettier-ignore -->
<template>
  <div class="flex flex-col h-full">
    <div class="flex flex-col items-center grow justify-center">
      <section class="flex flex-col items-center">
        <div style="text-shadow: 1px 1px 0 white">
          <div class="text-5xl leading-tight font-bold text-center mt-20 text-argon-text-primary">
            Earn Argons and Argonots
            <div>By Running Your Own Mining Node</div>
          </div>
          <p class="text-base text-justify w-[780px] !mx-auto mt-10 text-argon-text-primary">
            Argon is fully decentralized and democratic. Anyone can participate in the mining and rewards of the system, and
            a special auction process serves as gatekeeper. Auctions are held every 24 hours, and the winners are given the keys
            for ten days before the cycle repeats itself. The best thing is, special mining hardware provides no advantage.
            Argon is optimized for cheap virtual cloud machines, which makes getting involved easy and cost-effective.
            Click a button below to get started.
          </p>
        </div>
        <div class="flex flex-row items-center text-2xl mt-10 w-full justify-center gap-x-6">
          <button
            @click="openHowMiningWorksOverlay"
            class="cursor-pointer bg-white/10 hover:bg-argon-600/10 border border-argon-800/30 inner-button-shadow font-bold text-argon-600 [text-shadow:1px_1px_0_rgba(255,255,255,0.5)] px-12 py-2 rounded-md block"
          >
            Learn How Mining Works
          </button>
          <button
          ref="miningButtonRef"
            @click="startSettingUpMiner"
            class="flex flex-row cursor-pointer items-center gap-x-2 bg-argon-500 hover:bg-argon-600 border border-argon-700 inner-button-shadow font-bold text-white px-12 py-2 rounded-md"
          >
            Set Up Your Mining Operation
            <ChevronDoubleRightIcon class="size-5 relative top-px" />
          </button>
        </div>
      </section>
    </div>
    <div class="flex-grow flex flex-row items-end w-full">
      <div class="flex flex-col w-full px-5 pb-5">
        <ul
          class="flex flex-row text-center text-sm text-argon-text-primary w-full py-7 border-t border-b border-slate-300 mb-5"
        >
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              {{ miningStats.activeMiningSeatCount ? numeral(miningStats.activeMiningSeatCount).format('0,0') : '---' }}
            </div>
            <div>Mining Seats</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
                  {{ currency.symbol }}
                </span>
                <span>{{ microgonToMoneyNm(miningStats.aggregatedBidCosts).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
              </template>
              <template v-else>---</template>
            </div>
            <div>Active Seat Costs</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">
                <span :class="[currency.symbol === '₳' ? 'font-semibold' : 'font-bold']">
                  {{ currency.symbol }}
                </span>
                <span>{{ microgonToMoneyNm(miningStats.aggregatedBlockRewards).formatIfElse('< 1_000', '0,0.00', '0,0') }}</span>
              </template>
              <template v-else>---</template>
            </div>
            <div>Active Seat Rewards</div>
          </li>
          <li style="width: 1px" class="bg-slate-300"></li>
          <li class="w-1/4">
            <div class="text-4xl font-bold">
              <template v-if="isLoaded">{{ numeral(miningStats.currentAPY).formatCapped('0,0', 9_999) }}%</template>
              <template v-else>---</template>
            </div>
            <div>Annual Percentage Yield</div>
          </li>
        </ul>
        <BlankSlateBlocks />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
const isLoaded = Vue.ref(false);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { useMiningStats } from '../../stores/miningStats.ts';
import { useConfig } from '../../stores/config';
import { useCurrency } from '../../stores/currency';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import basicEmitter from '../../emitters/basicEmitter';
import BlankSlateBlocks from './components/BlankSlateBlocks.vue';
import { useTour } from '../../stores/tour';

const miningStats = useMiningStats();
const currency = useCurrency();
const config = useConfig();
const tour = useTour();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const miningButtonRef = Vue.ref<HTMLElement | null>(null);

function openHowMiningWorksOverlay() {
  basicEmitter.emit('openHowMiningWorksOverlay');
}

function startSettingUpMiner() {
  config.isPreparingMinerSetup = true;
}

tour.registerPositionCheck('miningButton', () => {
  const rect = miningButtonRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 20;
  rect.bottom += 20;
  return rect;
});

Vue.onMounted(async () => {
  Promise.all([
    miningStats.updateAggregateBidCosts(),
    miningStats.updateAggregateBlockRewards(),
    miningStats.updateActiveMiningSeatCount(),
  ]).then(() => {
    isLoaded.value = true;
  });
});
</script>
