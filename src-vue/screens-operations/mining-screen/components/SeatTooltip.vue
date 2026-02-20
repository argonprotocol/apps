<template>
  <div class="rounded-md border border-slate-800/20 bg-white px-1 text-base text-slate-800 shadow-lg">
    <div class="mx-2 flex flex-row gap-x-1 border-b border-slate-300 px-1 py-2 text-left font-light">
      <strong class="font-bold">Seat {{ seat.id }}</strong>
      <span v-if="seat.miner?.isOurs" class="text-slate-400">(OURS)</span>
      <span v-else class="text-slate-400">(OTHER)</span>
      <span class="grow text-right italic">{{ percentComplete }}% complete</span>
    </div>
    <div class="mx-2 border-b border-slate-300 px-1 py-2 text-left font-light italic">
      Mining from {{ startDate?.format('MMMM D, h:mma') || '-----' }} to
      {{ endDate?.format('MMMM D, h:mma') || '-----' }}
    </div>
    <table class="mx-2 mt-1 mb-2 whitespace-nowrap">
      <tbody>
        <tr>
          <td label>Winning Bid Price</td>
          <td colon>:</td>
          <td>
            {{ seat.miner ? `${currency.symbol}${microgonToMoneyNm(seat.miner.bidAmount).format('0,0.00')}` : '--.--' }}
          </td>
          <td label>ROI Absolute</td>
          <td colon>:</td>
          <td>{{ numeral(roiAbsolute).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9999) }}%</td>
        </tr>
        <tr>
          <td label>Value Received TD</td>
          <td colon>:</td>
          <td>
            {{ currency.symbol
            }}{{ revenueGenerated === null ? '--.--' : microgonToMoneyNm(revenueGenerated).format('0,0.00') }}
          </td>
          <td label>ROI Relative</td>
          <td colon>:</td>
          <td>{{ numeral(roiRelative).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9999) }}%</td>
        </tr>
        <tr>
          <td label>ARGN Collected</td>
          <td colon>:</td>
          <td>{{ microgonsEarned === null ? '--.--' : micronotToArgonotNm(microgonsEarned).format('0,0.[00]') }}</td>
          <td label>APY Relative</td>
          <td colon>:</td>
          <td>{{ numeral(apyRelative).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9999) }}%</td>
        </tr>
        <tr>
          <td label>ARGNOT Collected</td>
          <td colon>:</td>
          <td>{{ micronotsEarned === null ? '--.--' : micronotToArgonotNm(micronotsEarned).format('0,0.[00]') }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="hasAuction" class="border-t border-slate-300 font-light">
      <div class="mt-1 rounded bg-slate-100 px-1 py-2 text-base">
        <div>
          Is Rebidding for {{ newStartDate?.format('MMMM D, h:mma') || '-----' }} to
          {{ newEndDate?.format('MMMM D, h:mma') || '-----' }}
        </div>
        <div class="pt-2 pb-3">
          <div v-if="isWinningBid" class="font-medium">
            You Bid
            {{ seat.bid ? `${currency.symbol}${microgonToMoneyNm(seat.bid.bidAmount).format('0,0.00')}` : '--.--' }}
          </div>
          <div v-else-if="seat.bid?.bidAmount" class="font-medium">
            Someone Else Bid
            {{ seat.bid ? `${currency.symbol}${microgonToMoneyNm(seat.bid.bidAmount).format('0,0.00')}` : '--.--' }}
          </div>
          <div v-else class="font-medium">No Bid Yet</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  bigNumberToBigInt,
  calculateAPY,
  calculateProfitPct,
  IMiningSeat,
  NetworkConfig,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { getStats } from '../../../stores/stats.ts';
import { getCurrency } from '../../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getMining, getMiningFrames } from '../../../stores/mainchain.ts';
import { TICK_MILLIS } from '../../../lib/Env.ts';
import { BigNumber } from 'bignumber.js';

dayjs.extend(utc);

const stats = getStats();
const currency = getCurrency();
const miningFrames = getMiningFrames();
const mining = getMining();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = defineProps<{
  seat: IMiningSeat;
  ourBidAddresses: Set<string>;
  hasAuction: boolean;
}>();

const minerStartingFrameId = Vue.computed<number | null>(() => {
  return props.seat.miner?.startingFrameId || null;
});

const percentComplete = Vue.computed(() => {
  if (minerStartingFrameId.value === null) return 0;
  return Math.round(miningFrames.getMiningSeatProgress(minerStartingFrameId.value));
});
const isWinningBid = Vue.computed(() => {
  if (!props.seat.bid) return false;
  return props.ourBidAddresses.has(props.seat.bid.address);
});
const currentSlot = Vue.computed(() => {
  return stats.latestFrameId % 10;
});

const tickStart = Vue.ref(0);
const tickEnd = Vue.ref(0);
const micronotsEarned = Vue.ref<bigint | null>(null);
const microgonsEarned = Vue.ref<bigint | null>(null);

const newTickStart = Vue.ref(0);
const newTickEnd = Vue.ref(0);

const startDate = Vue.computed(() => {
  if (!tickStart.value) return null;

  return dayjs.utc(tickStart.value * TICK_MILLIS).local();
});

const endDate = Vue.computed(() => {
  if (!tickEnd.value) return null;

  return dayjs
    .utc(tickEnd.value * TICK_MILLIS)
    .local()
    .add(1, 'minute');
});

const newStartDate = Vue.computed(() => {
  if (!newTickStart.value) return null;

  return dayjs.utc(newTickStart.value * TICK_MILLIS).local();
});

const newEndDate = Vue.computed(() => {
  if (!newTickEnd.value) return null;

  return dayjs
    .utc(newTickEnd.value * TICK_MILLIS)
    .local()
    .add(1, 'minute');
});

const revenueGenerated = Vue.computed<bigint | null>(() => {
  if (micronotsEarned.value === null || microgonsEarned.value === null) {
    return null;
  }
  const valueOfMicronots = currency.convertMicronotTo(micronotsEarned.value!, UnitOfMeasurement.Microgon);
  return microgonsEarned.value + valueOfMicronots;
});

const roiRelative = Vue.computed(() => {
  if (!revenueGenerated.value || !props.seat.miner || minerStartingFrameId.value === null) return 0;
  const progress = miningFrames.getMiningSeatProgress(minerStartingFrameId.value);
  const factorBn = BigNumber(progress).dividedBy(100);
  const costBn = BigNumber(props.seat.miner.bidAmount).multipliedBy(factorBn);
  return calculateProfitPct(bigNumberToBigInt(costBn), revenueGenerated.value!) * 100;
});

const apyRelative = Vue.computed(() => {
  if (!revenueGenerated.value || !props.seat.miner || minerStartingFrameId.value === null) return 0;
  const progress = miningFrames.getMiningSeatProgress(minerStartingFrameId.value);
  const factorBn = BigNumber(progress).dividedBy(100);
  const costBn = BigNumber(props.seat.miner.bidAmount).multipliedBy(factorBn);
  return calculateAPY(bigNumberToBigInt(costBn), revenueGenerated.value!, 10);
});

const roiAbsolute = Vue.computed(() => {
  if (!revenueGenerated.value || !props.seat.miner) return 0;
  return calculateProfitPct(props.seat.miner.bidAmount, revenueGenerated.value!) * 100;
});

Vue.onBeforeMount(async () => {
  await miningFrames.load();

  if (minerStartingFrameId.value) {
    tickStart.value = miningFrames.getTickStart(minerStartingFrameId.value);
    tickEnd.value = miningFrames.estimateTickEnd(minerStartingFrameId.value + 9);

    const activeMinersCount = await mining.fetchActiveMinersCount();
    const progress = miningFrames.getMiningSeatProgress(minerStartingFrameId.value);
    const factorBn = BigNumber(progress).dividedBy(100);
    const micronotsTotal = await mining.minimumMicronotsMinedDuringTickRange(tickStart.value, tickEnd.value);
    const micronotsEarnedBn = BigNumber(micronotsTotal).dividedBy(activeMinersCount).multipliedBy(factorBn);
    micronotsEarned.value = bigNumberToBigInt(micronotsEarnedBn);

    const microgonsMinedPerBlock = await mining.fetchMicrogonsMinedPerBlockDuringNextCohort();
    const microgonsTotal = microgonsMinedPerBlock * BigInt(NetworkConfig.ticksPerCohort);
    const microgonsEarnedBn = BigNumber(microgonsTotal).dividedBy(activeMinersCount).multipliedBy(factorBn);
    microgonsEarned.value = bigNumberToBigInt(microgonsEarnedBn);
  }

  if (props.seat.bid?.startingFrameId) {
    newTickStart.value = miningFrames.estimateTickStart(props.seat.bid.startingFrameId);
    newTickEnd.value = miningFrames.estimateTickEnd(props.seat.bid.startingFrameId + 9);
  }
});
</script>

<style scoped>
@reference "../../../main.css";

table {
  td {
    text-align: left;
    padding-top: 5px;
    padding-bottom: 5px;
  }
  td[label] {
    @apply text-slate-700/50;
    text-align: right;
  }
  td[colon] {
    @apply px-2 text-slate-700/50;
  }
  td:nth-child(3) {
    padding-right: 30px;
  }
}
</style>
