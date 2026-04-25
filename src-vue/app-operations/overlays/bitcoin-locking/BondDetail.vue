<template>
  <div class="flex flex-row gap-8 px-10 pt-6 pb-8">
    <div class="relative w-28 shrink-0 pt-1">
      <BondIcon class="w-28 opacity-50" />
      <ArgonIcon class="absolute top-[73%] left-1/2 w-3 -translate-x-1/2 -translate-y-1/2 text-slate-700/70" />
    </div>

    <div class="grow">
      <div class="flex items-baseline gap-2">
        <span class="text-argon-600 font-mono text-2xl font-bold">
          {{ currency.symbol }}{{ microgonToMoneyNm(bondLotMicrogons).format('0,0.00') }}
        </span>
        <span class="text-sm text-slate-500">{{ summary.poolSharePct.toFixed(1) }}% of vault bonds</span>
      </div>

      <div class="mt-1 text-sm font-light text-slate-400">
        Bond lot for mining auction from {{ summary.frameStartDate }} to {{ summary.frameEndDate }}
      </div>

      <div v-if="bondLotDetails" class="mt-4 grid grid-cols-3 gap-4 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <div>
          <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Created</div>
          <div class="mt-1 text-slate-700">Frame {{ bondLotDetails.createdFrame }}</div>
        </div>
        <div>
          <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Lifetime Returns</div>
          <div class="mt-1 font-medium text-slate-700">
            {{ currency.symbol }}{{ microgonToMoneyNm(bondLotDetails.lifetimeEarnings).format('0,0.00') }}
          </div>
        </div>
        <div>
          <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Last Paid</div>
          <div class="mt-1 text-slate-700">
            {{ bondLotDetails.lastEarningsFrame == null ? 'Not yet' : `Frame ${bondLotDetails.lastEarningsFrame}` }}
          </div>
        </div>
      </div>

      <div class="mt-3 flex flex-row items-start gap-6 text-sm text-slate-600">
        <div>
          Earnings
          <span class="font-semibold">
            {{ currency.symbol }}{{ microgonToMoneyNm(summary.totalEarnings).format('0,0.00') }}
          </span>
        </div>
        <div class="text-slate-400">you keep {{ summary.keepPct.toFixed(0) }}%</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { BondLot, type IFrameBondSummary } from '@argonprotocol/apps-core';
import BondIcon from '../../../assets/bond.svg?component';
import ArgonIcon from '../../../assets/currencies/argon.svg?component';

const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  summary: IFrameBondSummary;
}>();

const bondLotDetails = Vue.computed(() => props.summary.bondLot.details);
const bondLotMicrogons = Vue.computed(() => BondLot.bondsToMicrogons(props.summary.bondLot.bonds));
</script>
