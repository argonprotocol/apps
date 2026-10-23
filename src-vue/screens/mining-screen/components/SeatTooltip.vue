<template>
  <div class="rounded-md border border-slate-800/20 bg-white px-1 text-base text-slate-800 shadow-lg">
    <div class="mx-2 flex flex-row gap-x-1 border-b border-slate-300 px-1 py-2 text-left font-light">
      <strong class="font-bold">Seat {{ seat.id }}</strong>
      <span v-if="seat.miner?.isOurs" class="text-slate-400">(YOURS)</span>
      <span v-else-if="seat.miner" class="text-slate-400">(OTHER)</span>
      <span v-else class="text-slate-400">(EMPTY)</span>
      <span class="grow text-right italic">{{ seatProgressPct }}% complete</span>
    </div>
    <div class="mx-2 border-b border-slate-300 px-1 py-2 text-left font-light italic">
      Mining from {{ startDate?.format('MMMM D, h:mma') || '-----' }} to
      {{ endDate?.format('MMMM D, h:mma') || '-----' }}
    </div>
    <div class="mx-2 px-1 pt-2 text-left text-sm font-light text-slate-400">
      Returns and rewards projected through term end
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
          <td>
            <template v-if="roiAbsolute !== undefined">
              {{
                numeral(roiAbsolute).formatIfElseCapped(
                  Math.abs(roiAbsolute) < 100,
                  Math.abs(roiAbsolute) < 10 ? '0,0.[00]' : '0,0.[0]',
                  '0,0',
                  9999,
                )
              }}%
            </template>
            <template v-else>--</template>
          </td>
        </tr>
        <tr>
          <td label>Value Received TD</td>
          <td colon>:</td>
          <td>
            <template v-if="rewardsToDate">
              {{ currency.symbol }}{{ microgonToMoneyNm(rewardsToDate.microgonValue).format('0,0.00') }}
            </template>
            <template v-else>--.--</template>
          </td>
          <td label>ROI Relative</td>
          <td colon>:</td>
          <td>
            <template v-if="roiRelative !== undefined">
              {{
                numeral(roiRelative).formatIfElseCapped(
                  Math.abs(roiRelative) < 100,
                  Math.abs(roiRelative) < 10 ? '0,0.[00]' : '0,0.[0]',
                  '0,0',
                  9999,
                )
              }}%
            </template>
            <template v-else>--</template>
          </td>
        </tr>
        <tr>
          <td label>ARGN Collected</td>
          <td colon>:</td>
          <td>
            <template v-if="rewardsToDate">
              {{ microgonToArgonNm(rewardsToDate.microgonsMined + rewardsToDate.microgonsMinted).format('0,0.[00]') }}
            </template>
            <template v-else>--.--</template>
          </td>
          <td label>{{ config.returnMetric }}</td>
          <td colon>:</td>
          <td>
            <Returns :returns="seatReturns" :showLabel="false" />
          </td>
        </tr>
        <tr>
          <td label>ARGNOT Collected</td>
          <td colon>:</td>
          <td>
            <template v-if="rewardsToDate">
              {{ micronotToArgonotNm(rewardsToDate.micronotsMined).format('0,0.[00]') }}
            </template>
            <template v-else>--.--</template>
          </td>
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
          <div v-else-if="seat.bid" class="font-medium">
            Someone Else Bid
            {{ `${currency.symbol}${microgonToMoneyNm(seat.bid.bidAmount ?? 0n).format('0,0.00')}` }}
          </div>
          <div v-else class="font-medium">No Bid Yet</div>
        </div>
      </div>
    </div>
    <div
      v-else-if="isUnavailableForBids"
      class="border-t border-slate-300 px-3 py-3 text-left font-medium text-slate-500"
    >
      This seat is not available for bids in the current frame.
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
  calculateMiningRewardProjection,
  calculateProfitPct,
  IMiningSeat,
  NetworkConfig,
  percentOf,
} from '@argonprotocol/apps-core';
import { getMyMiningSeats } from '../../../stores/myMiningSeats.ts';
import { getCurrency } from '../../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getMiningFrames } from '../../../stores/mainchain.ts';
import { TICK_MILLIS } from '../../../lib/Env.ts';
import { getMiningSeatProgressAtFrame } from '../miningSeatProgress.ts';
import type { IMiningSeatRewardTerms } from '../../../interfaces/db/ICohortRecord.ts';
import Returns from '../../../components/Returns.vue';
import { getConfig } from '../../../stores/config.ts';

dayjs.extend(utc);

const myMiningSeats = getMyMiningSeats();
const currency = getCurrency();
const config = getConfig();
const miningFrames = getMiningFrames();

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

type IMiningDisplaySeat = IMiningSeat & {
  startingFrameId?: number | null;
};

const props = defineProps<{
  seat: IMiningDisplaySeat;
  frameId: number;
  isLiveFrame: boolean;
  startingFrameId?: number | null;
  ourBidAddresses: Set<string>;
  hasAuction: boolean;
  isUnavailableForBids: boolean;
  tooltipStats?: IMiningSeatRewardTerms | null;
}>();

const seatStartingFrameId = Vue.computed<number | null>(() => {
  return props.startingFrameId ?? props.seat.startingFrameId ?? props.seat.miner?.startingFrameId ?? null;
});
const seatProgressPct = Vue.computed(() => {
  if (seatStartingFrameId.value === null) return 0;

  return Math.round(
    getMiningSeatProgressAtFrame(
      seatStartingFrameId.value,
      props.frameId,
      props.isLiveFrame ? miningFrames.getCurrentFrameProgress() : 100,
    ),
  );
});

const isWinningBid = Vue.computed(() => {
  if (!props.seat.bid) return false;
  return props.ourBidAddresses.has(props.seat.bid.address);
});

const tickStart = Vue.computed(() => {
  if (seatStartingFrameId.value === null) return 0;
  return miningFrames.getTickStart(seatStartingFrameId.value);
});

const tickEnd = Vue.computed(() => {
  if (seatStartingFrameId.value === null) return 0;
  return miningFrames.estimateTickEnd(seatStartingFrameId.value + 9);
});

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

const rewardsToDate = Vue.computed(() => {
  if (!props.tooltipStats || !props.seat.miner) return;

  let argonotPrice = currency.microgonsPer.ARGNOT;
  if (!props.isLiveFrame) {
    const frame = myMiningSeats.frames.find(frame => frame.id === props.frameId);
    argonotPrice = frame?.microgonToArgonot.at(-1) ?? 0n;
  }
  if (argonotPrice <= 0n) return;

  return calculateMiningRewardProjection({
    bidPrincipal: props.seat.miner.bidAmount,
    microgonsPerTerm: props.tooltipStats.microgonsToBeMinedPerSeat,
    micronotsPerTerm: props.tooltipStats.micronotsToBeMinedPerSeat,
    argonotPrice,
    percentOfTerm: seatProgressPct.value,
  });
});

const roiRelative = Vue.computed(() => {
  if (!rewardsToDate.value || !props.seat.miner) return;

  const accruedBidCost = percentOf(props.seat.miner.bidAmount, seatProgressPct.value);
  if (accruedBidCost <= 0n) return;

  return calculateProfitPct(accruedBidCost, rewardsToDate.value.microgonValue) * 100;
});

const seatReturns = Vue.computed(() => {
  if (!rewardsToDate.value || !props.seat.miner) return;

  const accruedBidCost = percentOf(props.seat.miner.bidAmount, seatProgressPct.value);
  if (accruedBidCost <= 0n) return;

  const annualizedInput = {
    startingValue: accruedBidCost,
    endingValue: rewardsToDate.value.microgonValue,
    periodDays: NetworkConfig.framesPerCohort,
  };
  return {
    percent: calculateProfitPct(props.seat.miner.bidAmount, rewardsToDate.value.microgonValue) * 100,
    apr: calculateAnnualPercentageRate(annualizedInput),
    apy: calculateAnnualPercentageYield(annualizedInput),
  };
});

const roiAbsolute = Vue.computed(() => {
  if (!rewardsToDate.value || !props.seat.miner) return;
  if (props.seat.miner.bidAmount <= 0n) return;

  return calculateProfitPct(props.seat.miner.bidAmount, rewardsToDate.value.microgonValue) * 100;
});

Vue.watch(
  () => myMiningSeats.selectedFrameId,
  () => {
    if (!props.hasAuction) {
      newTickStart.value = 0;
      newTickEnd.value = 0;
      return;
    }
    const auctionStartingFrameId = myMiningSeats.selectedFrameId + 1;
    const auctionEndingFrameId = auctionStartingFrameId + 9;
    newTickStart.value =
      auctionStartingFrameId <= miningFrames.currentFrameId
        ? miningFrames.getTickStart(auctionStartingFrameId)
        : miningFrames.estimateTickStart(auctionStartingFrameId);
    newTickEnd.value =
      auctionEndingFrameId <= miningFrames.currentFrameId
        ? miningFrames.getTickEnd(auctionEndingFrameId)
        : miningFrames.estimateTickEnd(auctionEndingFrameId);
  },
  { immediate: true },
);
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
