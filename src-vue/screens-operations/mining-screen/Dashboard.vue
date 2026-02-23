<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" class="flex flex-col h-full">
    <div data-testid="MiningDashboard" :class="stats.isLoaded ? '' : 'opacity-30 pointer-events-none'" class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <section class="flex flex-row gap-x-2 h-[14%]">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ stats.global.seatsTotal || 0 }}</span>
            <label>Total Mining Seat{{ stats.global.seatsTotal === 1 ? '' : 's' }}</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of mining seats you've controlled over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(stats.global.framesCompleted).format('0,0.[00]') }}</span>
            <label>Frame{{ stats.global.framesCompleted === 1 ? '' : 's' }} Completed</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of frames that you've mined over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(stats.global.framesRemaining).format('0,0.[00]') }}</span>
            <label>Frame{{ stats.global.framesRemaining === 1 ? '' : 's' }} Remaining</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of future frames for which you own mining rights.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(globalMicrogonsInvested).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <label>Relative Total Cost</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your total cost for mining frames that have already completed.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(globalMicrogonsEarned).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <label>Relative Total Earnings</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The total amount you've earned from completed mining frames.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(globalROI).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%</span>
            <label>Current Profit</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your annual percentage yield based on frames that have been completed.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
      </section>

      <section class="flex flex-row gap-x-2.5 grow">
        <div box class="flex flex-col w-[22.5%] px-2">
          <header class="flex flex-row items-center px-1 border-b border-slate-400/30 pt-2 pb-3 text-[18px] font-bold text-slate-900/80">
            <div class="grow">Mining Assets</div>
            <CopyAddressMenu :walletType="WalletType.miningHold" class="mr-1" />
            <AssetMenu :walletType="WalletType.miningHold" />
          </header>
          <MiningAssetBreakdown />
          <div class="grow border-t border-slate-600/40 flex flex-col items-center justify-center">
            <div @click="openHowMiningWorksOverlay" class="text-center text-argon-600/60 hover:text-argon-600 cursor-pointer">
              <InstructionsIcon class="w-6 h-6 inline-block" />
              <div>Learn About Mining</div>
            </div>
          </div>
          <div class="flex flex-row items-end border-t border-slate-600/20 pt-2 text-md">
            <div @click="openPortfolioPanel(PortfolioTab.ProfitAnalysis)" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <RoiIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Profits</div>
            </div>
            <div class="w-px h-full bg-slate-600/20" />
            <div @click="openPortfolioPanel(PortfolioTab.GrowthProjections)" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <ProjectionsIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Projections</div>
            </div>
            <div class="w-px h-full bg-slate-600/20" />
            <div @click="openBotEditOverlay" class="grow relative text-center text-argon-600 opacity-70 hover:opacity-100 cursor-pointer">
              <ConfigIcon class="w-6 h-6 mt-2 inline-block mb-2" />
              <div>Settings</div>
            </div>
          </div>
        </div>

        <div class="flex flex-col grow gap-y-2">
          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 text-slate-900/80 border-b border-slate-400/30 select-none">
              <div @click="goToPrevFrame" :class="hasPrevFrame ? 'opacity-60' : 'opacity-20 pointer-events-none'" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                <ChevronLeftIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
                PREV
              </div>
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="stats.selectedFrameId > stats.latestFrameId - 10" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
              </span>
              <div v-if="currentFrame.progress >= 100" @click="goToNextFrame" class="flex flex-row opacity-60 items-center font-light text-base cursor-pointer group hover:opacity-80">
                NEXT
                <ChevronRightIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
              </div>
              <div v-else class="flex flex-row opacity-60 items-center font-light text-base group px-2">
                {{ numeral(currentFrame.progress).format('0.0') }}%
              </div>
            </header>
            <div v-if="currentFrame.seatCountActive" class="flex flex-col h-full">
              <div class="flex w-full grow pt-4 px-2">
                <MiningSeats />
              </div>
              <div class="pt-4 pb-3">
                <div class="mb-2 flex items-center gap-x-3 text-center">
                  <span class="h-px grow bg-slate-400/30"></span>
                  <span class="text-base leading-none font-bold text-slate-700/60">Mining Auction Stats</span>
                  <span class="h-px grow bg-slate-400/30"></span>
                </div>
                <div class="grid grid-cols-4 gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                  <div>{{ numeral(auctionBidCount).format('0,0') }} Bids Placed this Frame</div>
                  <div>{{ formatBidAmount(highestWinningBid) }} Is the Highest Bid</div>
                  <div>{{ formatBidAmount(myNextBidMicrogons) }} Is Your Next Bid</div>
                  <div>Your Next Bid In {{ nextBidInText }}</div>
                  <div>{{ auctionStatsLabel }}</div>
                  <div>{{ formatBidAmount(lowestWinningBid) }} Is the Lowest Bid</div>
                  <div>{{ formatBidAmount(myLastBidMicrogons) }} Was Your Last Bid</div>
                  <div class="titleize">Auction Closes In {{ auctionClosesInText }}</div>
                </div>
              </div>
            </div>
            <div v-else-if="currentFrame.id === stats.latestFrameId" class="flex flex-col items-center justify-center h-full text-slate-900/20 text-2xl font-bold">
              You Have No Mining Seats
            </div>
            <div v-else class="flex flex-col items-center justify-center h-full text-slate-900/20 text-2xl font-bold">
              You Had No Mining Seats During This Frame
            </div>
          </section>

          <section box class="relative flex flex-col h-[35%] !pb-0.5 px-2">
            <FrameSlider ref="frameSliderRef" :chartItems="chartItems" @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>
  </TooltipProvider>
</template>

<script lang="ts">
import * as Vue from 'vue';
import { IDashboardFrameStats } from '../../interfaces/IStats.ts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';

// storing refs outside of setup to avoid re-creation on each setup call and speed ui load
const currentFrame = Vue.ref<IDashboardFrameStats>({
  id: 0,
  date: '',
  firstTick: 0,
  allMinersCount: 0,
  seatCountActive: 0,
  seatCostTotalFramed: 0n,
  microgonToUsd: [0n],
  microgonToArgonot: [0n],
  blocksMinedTotal: 0,

  micronotsMinedTotal: 0n,
  microgonsMinedTotal: 0n,
  microgonsMintedTotal: 0n,
  microgonFeesCollectedTotal: 0n,
  microgonValueOfRewards: 0n,

  progress: 0,
  profit: 0,
  profitPct: 0,
  score: 0,
  accruedMicrogonProfits: 0n,

  expected: {
    blocksMinedTotal: 0,
    micronotsMinedTotal: 0n,
    microgonsMinedTotal: 0n,
    microgonsMintedTotal: 0n,
  },
});
const sliderFrameIndex = Vue.ref(0);

dayjs.extend(relativeTime);
dayjs.extend(utc);
</script>

<script setup lang="ts">
import { BigNumber } from 'bignumber.js';
import { calculateProfitPct } from '@argonprotocol/apps-core';
import { getStats } from '../../stores/stats';
import { getCurrency } from '../../stores/currency';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import numeral, { createNumeralHelpers } from '../../lib/numeral';
import { TICK_MILLIS } from '../../lib/Env.ts';
import ConfigIcon from '../../assets/config.svg?component';
import InstructionsIcon from '../../assets/instructions.svg?component';
import FrameSlider from '../../components/FrameSlider.vue';
import { IChartItem } from '../../interfaces/IChartItem.ts';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import MiningAssetBreakdown from '../components/MiningAssetBreakdown.vue';
import MiningSeats from './components/MiningSeats.vue';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getConfig } from '../../stores/config.ts';
import { UnitOfMeasurement } from '../../lib/Currency.ts';
import { PortfolioTab } from '../../panels/interfaces/IPortfolioTab.ts';
import ProjectionsIcon from '../../assets/projections.svg';
import RoiIcon from '../../assets/roi.svg';
import { WalletType } from '../../lib/Wallet.ts';
import AssetMenu from '../components/AssetMenu.vue';
import CopyAddressMenu from '../components/CopyAddressMenu.vue';
import { getBot } from '../../stores/bot.ts';

const bot = getBot();
const stats = getStats();
const currency = getCurrency();
const miningFrames = getMiningFrames();
const config = getConfig();

const { microgonToMoneyNm, micronotToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const chartItems = Vue.ref<IChartItem[]>([]);

const auctionBids = Vue.computed(() => {
  return stats.allWinningBids ?? [];
});

const auctionBidCount = Vue.ref(0);

const highestWinningBid = Vue.computed<bigint | null>(() => {
  const bidAmounts = auctionBids.value
    .map(bid => bid.microgonsPerSeat)
    .filter((amount): amount is bigint => amount !== undefined);
  if (!bidAmounts.length) return null;
  return bidAmounts.reduce((max, amount) => (amount > max ? amount : max), bidAmounts[0]);
});

const lowestWinningBid = Vue.computed<bigint | null>(() => {
  const bidAmounts = auctionBids.value
    .map(bid => bid.microgonsPerSeat)
    .filter((amount): amount is bigint => amount !== undefined);
  if (!bidAmounts.length) return null;
  return bidAmounts.reduce((min, amount) => (amount < min ? amount : min), bidAmounts[0]);
});

const myWinningBids = Vue.computed(() => {
  return auctionBids.value.filter(bid => typeof bid.subAccountIndex === 'number');
});

const myLastBidMicrogons = Vue.computed<bigint | null>(() => {
  if (!myWinningBids.value.length) return null;
  const sorted = [...myWinningBids.value].sort((a, b) => (a.lastBidAtTick ?? 0) - (b.lastBidAtTick ?? 0));
  return sorted.at(-1)?.microgonsPerSeat ?? null;
});

const myNextBidMicrogons = Vue.computed<bigint | null>(() => {
  if (myLastBidMicrogons.value === null) return null;
  const bidIncrement = config.biddingRules?.rebiddingIncrementBy ?? 0n;
  return myLastBidMicrogons.value + bidIncrement;
});

const avgMicronotsPerWinningBid = Vue.computed<bigint | null>(() => {
  if (!auctionBids.value.length) return null;
  const total = auctionBids.value.reduce((sum, bid) => sum + (bid.micronotsStakedPerSeat ?? 0n), 0n);
  return total / BigInt(auctionBids.value.length);
});

const nextBidInText = Vue.computed(() => {
  const delayMinutes = config.biddingRules?.rebiddingDelay;
  if (!delayMinutes) return '---';
  return `${delayMinutes} Minute${delayMinutes === 1 ? '' : 's'}`;
});

const auctionClosesInText = Vue.computed(() => {
  if (currentFrame.value.id !== stats.latestFrameId) return '---';
  const frameEndTick = miningFrames.getTickEnd(currentFrame.value.id);
  if (!frameEndTick) return '---';
  const relativeTime = dayjs
    .utc(frameEndTick * TICK_MILLIS)
    .local()
    .add(1, 'minute')
    .fromNow(true);
  return relativeTime.replace(/\b\w/g, char => char.toUpperCase());
});

const auctionStatsLabel = Vue.computed(() => {
  const total = avgMicronotsPerWinningBid.value;
  if (total === null) return '--- ARGNOT Per Seat';
  return `${micronotToArgonotNm(total).format('0,0.[00]')} ARGNOT / Seat`;
});

function formatBidAmount(microgons: bigint | null): string {
  if (microgons === null) return '---';
  return `${currency.symbol}${microgonToMoneyNm(microgons).format('0,0')}`;
}

function getPercent(value: bigint | number, total: bigint | number): number {
  if (total === 0n || total === 0) return 0;
  return BigNumber(value).dividedBy(total).multipliedBy(100).toNumber();
}

const globalMicrogonsEarned = Vue.computed(() => {
  const {
    microgonsMinedTotal: totalMicrogonsMined,
    microgonsMintedTotal: totalMicrogonsMinted,
    micronotsMinedTotal: totalMicronotsMined,
  } = stats.global;
  return (
    totalMicrogonsMined +
    totalMicrogonsMinted +
    currency.convertMicronotTo(totalMicronotsMined, UnitOfMeasurement.Microgon)
  );
});

const globalMicrogonsInvested = Vue.computed(() => {
  return stats.global.framedCost;
});

const globalROI = Vue.computed(() => {
  return calculateProfitPct(globalMicrogonsInvested.value, globalMicrogonsEarned.value) * 100;
});

const currentFrameEarnings = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;

  const { microgonsMinedTotal, microgonsMintedTotal, micronotsMinedTotal } = currentFrame.value;
  const microgons = microgonsMinedTotal + microgonsMintedTotal;
  return microgons + currency.convertMicronotTo(micronotsMinedTotal, UnitOfMeasurement.Microgon);
});

const expectedFrameEarnings = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;

  const { expected } = currentFrame.value;
  const microgons = expected.microgonsMinedTotal + expected.microgonsMintedTotal;
  return microgons + currency.convertMicronotTo(expected.micronotsMinedTotal, UnitOfMeasurement.Microgon);
});

const currentFrameCost = Vue.computed(() => {
  if (!currentFrame.value.seatCountActive) return 0n;
  return currentFrame.value.seatCostTotalFramed;
});

const currentFrameProfit = Vue.computed(() => {
  const earningsBn = BigNumber(currentFrameEarnings.value);
  const costBn = BigNumber(currentFrameCost.value);
  const profitBn = earningsBn.minus(costBn).dividedBy(costBn).multipliedBy(100);
  return profitBn.toNumber();
});

const expectedFrameProfit = Vue.computed(() => {
  const earningsBn = BigNumber(expectedFrameEarnings.value);
  const costBn = BigNumber(currentFrameCost.value);
  if (costBn.isZero()) {
    return 0;
  }
  const profitBn = earningsBn.minus(costBn).dividedBy(costBn).multipliedBy(100);
  return profitBn.toNumber();
});

const currentFrameStartDate = Vue.computed(() => {
  if (!currentFrame.value.firstTick) {
    return '-----';
  }
  const date = dayjs.utc(currentFrame.value.firstTick * TICK_MILLIS);
  return date.local().format('MMMM D, h:mm A');
});

const currentFrameEndDate = Vue.computed(() => {
  const frameEndTick = miningFrames.getTickEnd(currentFrame.value.id);
  if (!frameEndTick) {
    return '-----';
  }
  const date = dayjs.utc(frameEndTick * TICK_MILLIS);
  return date.local().add(1, 'minute').format('MMMM D, h:mm A');
});

const hasNextFrame = Vue.computed(() => {
  return sliderFrameIndex.value < stats.frames.length - 1;
});

const hasPrevFrame = Vue.computed(() => {
  return sliderFrameIndex.value > 0;
});

function goToPrevFrame() {
  frameSliderRef.value?.goToPrevFrame();
}

function goToNextFrame() {
  frameSliderRef.value?.goToNextFrame();
}

function openBotEditOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

function openPortfolioPanel(tab: PortfolioTab) {
  basicEmitter.emit('openPortfolioPanel', tab);
}

function openHowMiningWorksOverlay() {
  basicEmitter.emit('openHowMiningWorksOverlay');
}

function loadChartData() {
  let isFiller = true;
  const items: IChartItem[] = [];
  for (const [index, frame] of stats.frames.entries()) {
    if (isFiller && frame.seatCountActive > 0) {
      const previousItem = items[index - 1];
      previousItem && (previousItem.isFiller = false);
      isFiller = false;
    }
    const item: IChartItem = {
      id: frame.id,
      date: frame.date,
      score: frame.score,
      isFiller,
      previous: items[index - 1],
      next: undefined,
    };
    items.push(item);
  }

  for (const [index, item] of items.entries()) {
    item.next = items[index + 1];
  }

  chartItems.value = items;
}

function updateSliderFrame(newFrameIndex: number) {
  sliderFrameIndex.value = newFrameIndex;
  currentFrame.value = stats.frames[newFrameIndex];
}

Vue.watch(
  () => stats.frames,
  () => {
    loadChartData();
    updateSliderFrame(sliderFrameIndex.value);
  },
  { deep: true },
);

Vue.onMounted(async () => {
  stats.subscribeToDashboard();
  stats.subscribeToActivity();
  loadChartData();
  await miningFrames.load();
  const client = await getMainchainClient(false);
  const historical = await client.query.miningSlot.historicalBidsPerSlot();
  auctionBidCount.value = historical[0].bidsCount.toNumber();
});

Vue.onUnmounted(() => {
  stats.unsubscribeFromDashboard();
  stats.unsubscribeFromActivity();
});
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 flex flex-col items-center justify-center;
  span {
    @apply font-mono text-3xl font-bold;
  }
  label {
    @apply group-hover:text-argon-600/60 mt-1 text-sm text-gray-500;
  }
}
[spinner] {
  @apply h-6 min-h-6 w-6 min-w-6;
  &.active {
    border-radius: 50%;
    border: 10px solid;
    border-color: rgba(166, 0, 212, 0.15) rgba(166, 0, 212, 0.25) rgba(166, 0, 212, 0.35) rgba(166, 0, 212, 0.5);
    animation: rotation 1s linear infinite;
  }
}
</style>
