<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" class="flex flex-col h-full">
    <div data-testid="MiningDashboard" :class="myMiningSeats.isLoaded ? '' : 'opacity-30 pointer-events-none'" class="flex flex-col h-full px-2.5 py-2.5 gap-y-2 justify-stretch grow">
      <span data-testid="TotalBlocksMined" :data-value="totalBlocksMined" class="sr-only">{{ totalBlocksMined }}</span>

      <section class="flex flex-row gap-x-2 h-[14%]">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ myMiningSeats.global.seatsTotal || 0 }}</span>
            <label>Total Mining Seat{{ myMiningSeats.global.seatsTotal === 1 ? '' : 's' }}</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of mining seats you've controlled over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(myMiningSeats.global.framesCompleted).format('0,0.[00]') }}</span>
            <label>Frame{{ myMiningSeats.global.framesCompleted === 1 ? '' : 's' }} Completed</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of frames that you've mined over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>{{ numeral(myMiningSeats.global.framesRemaining).format('0,0.[00]') }}</span>
            <label>Frame{{ myMiningSeats.global.framesRemaining === 1 ? '' : 's' }} Remaining</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of future frames for which you own mining rights.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-2/12 !py-4 group">
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(myMiningSeats.global.framedCost).formatIfElse('< 100', '0.00', '0,0') }}
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
              {{ currency.symbol }}{{ microgonToMoneyNm(myMiningSeats.global.microgonValueOfRewards).formatIfElse('< 100', '0.00', '0,0') }}
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
            <span>{{ numeral(elapsedMiningReturn).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%</span>
            <label>Current Profit</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your current profit based on the portion of your mining frames completed so far.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
      </section>

      <section class="flex flex-row gap-x-2.5 grow">
        <div box class="flex flex-col w-[22.5%] px-2">
          <header class="flex flex-row items-center px-1 border-b border-slate-400/30 pt-2 pb-3 text-[18px] font-bold text-slate-900/80">
            <div class="grow">Mining Assets</div>
            <CopyAddressMenu :walletType="WalletType.defaultArgon" class="mr-1" />
            <AssetMenu :walletType="WalletType.defaultArgon" />
          </header>
          <MiningAssetBreakdown />
          <div class="grow border-t border-slate-600/40 flex flex-col items-center justify-center">
            <a target="_blank" href="https://argon.network/docs/mining-operations" class="flex flex-row items-center text-center text-argon-600/60! hover:text-argon-600! cursor-pointer">
              <div>Learn About Mining</div>
              <ArrowTopRightOnSquareIcon class="w-5 ml-2" />
            </a>
          </div>
          <div class="flex flex-row items-end border-t border-slate-600/20 pt-2 text-md">
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
                <span v-if="myMiningSeats.selectedFrameId > myMiningSeats.latestFrameId - 10" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
                <span
                  v-if="isFrameDetailLoading"
                  class="ml-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500/55 animate-pulse">
                  Updating
                </span>
              </span>
              <div v-if="currentFrame.progress >= 100" @click="goToNextFrame" class="flex flex-row opacity-60 items-center font-light text-base cursor-pointer group hover:opacity-80">
                NEXT
                <ChevronRightIcon class="w-6 h-6 opacity-50 mx-1 group-hover:opacity-80" />
              </div>
              <div v-else class="flex flex-row opacity-60 items-center font-light text-base group px-2">
                {{ numeral(currentFrame.progress).format('0.0') }}%
              </div>
            </header>
            <div class="relative flex flex-col h-full grow" :aria-busy="isFrameDetailLoading">
              <div
                :class="
                  isFrameDetailLoading
                    ? 'flex flex-col h-full grow opacity-80 transition-opacity duration-150'
                    : 'flex flex-col h-full grow opacity-100 transition-opacity duration-150'
                "
                class="flex w-full grow pt-4 px-2"
              >
                <div class="flex w-full grow pt-4 px-2">
                  <MiningSeats
                    :isLiveFrame="currentFrame.id === myMiningSeats.latestFrameId"
                    :frameId="currentFrame.id"
                    :lastBlockMinerAddress="lastBlockMinerAddress"
                    :frameSlots="frameSlots" />
                </div>
                <div class="pt-4 pb-3">
                  <div class="mb-2 flex items-center gap-x-3 text-center">
                    <span class="h-px grow bg-slate-400/30"></span>
                  </div>
                  <div class="grid grid-cols-4 gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                    <div>{{ numeral(auctionBidCount).format('0,0') }} Bids Placed this Frame</div>
                    <div>{{ formatBidAmount(highestWinningBid) }} Is the Highest Bid</div>
                    <div>{{ nextBidPrimaryLabel }}</div>
                    <CountdownClock
                      v-if="countdownNextBidAt"
                      :time="countdownNextBidAt"
                      v-slot="{ hours, minutes, seconds }">
                      <div class="titleize">
                        <template v-if="hours || minutes || seconds">
                          Your Next Bid In
                          {{
                            hours
                              ? `${hours} Hour${hours === 1 ? '' : 's'}`
                              : minutes
                                ? `${minutes} Minute${minutes === 1 ? '' : 's'}`
                                : `${seconds} Second${seconds === 1 ? '' : 's'}`
                          }}
                        </template>
                        <template v-else>
                          Your Next Bid Pending
                        </template>
                      </div>
                    </CountdownClock>
                    <div v-else>{{ nextBidTimingLabel }}</div>
                    <div>{{ auctionStatsLabel }}</div>
                    <div>{{ formatBidAmount(lowestWinningBid) }} Is the Lowest Bid</div>
                    <div>{{ formatBidAmount(myLastBidMicrogons) }} Was Your Last Bid</div>
                    <CountdownClock
                      v-if="countdownAuctionCloseAt"
                      :time="countdownAuctionCloseAt"
                      v-slot="{ hours, minutes, seconds }">
                      <div class="titleize">
                        <template v-if="hours || minutes || seconds">
                          Auction Closing In
                          {{
                            hours
                              ? `${hours} Hour${hours === 1 ? '' : 's'}`
                              : minutes
                                ? `${minutes} Minute${minutes === 1 ? '' : 's'}`
                                : `${seconds} Second${seconds === 1 ? '' : 's'}`
                          }}
                        </template>
                        <template v-else>
                          Auction May Close Any Moment
                        </template>
                      </div>
                    </CountdownClock>
                    <div v-else class="titleize">{{ auctionTimingLabel }}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section box class="relative flex flex-col h-[35%] !pb-0.5 px-2">
            <FrameSlider
              ref="frameSliderRef"
              :chartItems="chartItems"
              :selectedIndex="sliderFrameIndex"
              @changedFrame="updateSliderFrame" />
          </section>
        </div>
      </section>
    </div>
  </TooltipProvider>
</template>

<script lang="ts">
import * as Vue from 'vue';
import type { IMiningFrameDetail } from '@argonprotocol/apps-core';
import { IDashboardFrameStats } from '../../interfaces/IMiningSeatStats.ts';
import type { IChartItem } from '../../interfaces/IChartItem.ts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';

// Keep dashboard state warm across unmounts so switching tabs doesn't cold-start the view.
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
    microgonValueOfRewards: 0n,
  },
});
const chartItems = Vue.ref<IChartItem[]>([]);
const frameDetail = Vue.ref<IMiningFrameDetail | null>(null);
const latestLiveFrameDetail = Vue.ref<IMiningFrameDetail | null>(null);
const loadingFrameId = Vue.ref<number | null>(null);
const historicalFrameDetailByFrameId = new Map<number, IMiningFrameDetail>();
const pendingFrameDetailByFrameId = new Map<number, Promise<IMiningFrameDetail>>();
let frameDetailRequestId = 0;

dayjs.extend(relativeTime);
dayjs.extend(utc);
</script>

<script setup lang="ts">
import { BigNumber } from 'bignumber.js';
import { calculateProfitPct, Mining } from '@argonprotocol/apps-core';
import { getMyMiningSeats } from '../../stores/myMiningSeats.ts';
import { getCurrency } from '../../stores/currency.ts';
import { ArrowTopRightOnSquareIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';
import ConfigIcon from '../../assets/config.svg?component';
import FrameSlider from '../../components/FrameSlider.vue';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow } from 'reka-ui';
import basicEmitter from '../../emitters/basicEmitter.ts';
import CountdownClock from '../../components/CountdownClock.vue';
import MiningAssetBreakdown from '../components/MiningAssetBreakdown.vue';
import MiningSeats from './components/MiningSeats.vue';
import { getBlockWatch, getMainchainClient, getMining, getMiningFrames } from '../../stores/mainchain.ts';
import { WalletType } from '../../lib/Wallet.ts';
import AssetMenu from '../components/AssetMenu.vue';
import CopyAddressMenu from '../../components/CopyAddressMenu.vue';
import { botEmitter } from '../../lib/Bot.ts';
import { getBot } from '../../stores/bot.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import { useWallets } from '../../stores/wallets.ts';

const controller = useCertificationController();
const myMiningSeats = getMyMiningSeats();
const currency = getCurrency();
const bot = getBot();
const blockWatch = getBlockWatch();
const mining = getMining();
const miningFrames = getMiningFrames();
const wallets = useWallets();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const lastBlockMinerAddress = Vue.ref<string>();
const liveAuctionCloseTick = Vue.ref<{ frameId: number; tick: number } | null>(null);

let foregroundRefreshPromise: Promise<void> | null = null;
let stopBestBlockSubscription: (() => void) | null = null;

const sliderFrameIndex = Vue.computed(() => {
  const lastIndex = Math.max(myMiningSeats.frames.length - 1, 0);
  const selectedIndex = myMiningSeats.frames.findIndex(frame => frame.id === myMiningSeats.selectedFrameId);
  return Math.min(Math.max(selectedIndex >= 0 ? selectedIndex : lastIndex, 0), lastIndex);
});
const isSelectedLiveFrame = Vue.computed(() => {
  return currentFrame.value.id === myMiningSeats.latestFrameId;
});
const isTargetingLiveFrame = Vue.computed(() => {
  return myMiningSeats.selectedFrameId === myMiningSeats.latestFrameId;
});
const isFrameDetailLoading = Vue.computed(() => {
  return !isSelectedLiveFrame.value && loadingFrameId.value === currentFrame.value.id;
});
const finalizedFrameId = Vue.computed(() => {
  return bot.state?.finalizedFrameId ?? 0;
});
const currentFrameDetail = Vue.computed(() => {
  if (frameDetail.value?.frameId === currentFrame.value.id) {
    return frameDetail.value;
  }
  if (
    currentFrame.value.id === myMiningSeats.latestFrameId &&
    latestLiveFrameDetail.value?.frameId === currentFrame.value.id
  ) {
    return latestLiveFrameDetail.value;
  }

  return historicalFrameDetailByFrameId.get(currentFrame.value.id) ?? null;
});

const auctionBids = Vue.computed(() => {
  if (isSelectedLiveFrame.value) {
    return myMiningSeats.allWinningBids ?? [];
  }

  return currentFrameDetail.value?.winningBids ?? [];
});

const auctionBidCount = Vue.computed(() => {
  return currentFrameDetail.value?.totalBidCount ?? 0;
});

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

const myLastBidMicrogons = Vue.computed<bigint | null>(() => {
  if (isTargetingLiveFrame.value) {
    return bot.state?.lastBid?.microgonsPerSeat ?? currentFrameDetail.value?.myLastBidMicrogons ?? null;
  }

  return currentFrameDetail.value?.myLastBidMicrogons ?? null;
});

const liveNextBid = Vue.computed(() => {
  if (!isTargetingLiveFrame.value) return null;
  return bot.state?.nextBid ?? null;
});

const myNextBidMicrogons = Vue.computed(() => {
  return liveNextBid.value?.microgonsPerSeat;
});

const nextBidPrimaryLabel = Vue.computed(() => {
  return `${myNextBidMicrogons.value === undefined ? '---' : formatBidAmount(myNextBidMicrogons.value)} Is Your Next Bid`;
});

const nextBidTimingLabel = Vue.computed(() => {
  return 'No Rebid Planned';
});

const avgMicronotsPerWinningBid = Vue.computed<bigint | null>(() => {
  if (!auctionBids.value.length) return null;
  const total = auctionBids.value.reduce((sum, bid) => sum + (bid.micronotsStakedPerSeat ?? 0n), 0n);
  return total / BigInt(auctionBids.value.length);
});

const auctionTimingLabel = Vue.computed(() => {
  const auctionCloseTick = currentFrameDetail.value?.auctionCloseTick ?? null;
  if (isSelectedLiveFrame.value) {
    if (auctionCloseTick) {
      const auctionClosedAt = dayjs.utc(auctionCloseTick * TICK_MILLIS).local();
      return `Auction Closed ${auctionClosedAt.format('h:mm A')}`;
    }

    return 'Auction Closing Pending';
  }

  if (!auctionCloseTick) return 'Auction Closed -----';

  const auctionClosedAt = dayjs.utc(auctionCloseTick * TICK_MILLIS).local();

  return `Auction Closed ${auctionClosedAt.format('h:mm A')}`;
});

const countdownNextBidAt = Vue.computed(() => {
  const nextBidTick = liveNextBid.value?.atTick ?? null;
  if (!nextBidTick) return null;
  return dayjs.utc((nextBidTick + 1) * TICK_MILLIS);
});

const countdownAuctionCloseAt = Vue.computed(() => {
  if (!isSelectedLiveFrame.value) return null;
  const auctionCloseTick = currentFrameDetail.value?.auctionCloseTick ?? null;
  if (auctionCloseTick) return null;

  const expectedAuctionCloseTick =
    liveAuctionCloseTick.value?.frameId === currentFrame.value.id
      ? liveAuctionCloseTick.value.tick
      : (currentFrameDetail.value?.expectedAuctionCloseTick ?? null);
  if (!expectedAuctionCloseTick) return null;

  return dayjs.utc(expectedAuctionCloseTick * TICK_MILLIS);
});

const auctionStatsLabel = Vue.computed(() => {
  const total = avgMicronotsPerWinningBid.value;
  if (total === null) return '--- ARGNOT Per Seat';
  return `${micronotToArgonotNm(total).format('0,0.[00]')} ARGNOT / Seat`;
});

function formatBidAmount(microgons: bigint | null): string {
  if (microgons === null) return '---';
  return `${currency.symbol}${microgonToMoneyNm(microgons).formatIfElse('<100', '0,0.00', '0,0')}`;
}

const elapsedMiningReturn = Vue.computed(() => {
  return calculateProfitPct(myMiningSeats.global.framedCost, myMiningSeats.global.microgonValueOfRewards) * 100;
});

const totalBlocksMined = Vue.computed(() => {
  return myMiningSeats.frames.reduce((sum, frame) => sum + frame.blocksMinedTotal, 0);
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

function loadChartData() {
  let isFiller = true;
  const items: IChartItem[] = [];
  for (const [index, frame] of myMiningSeats.frames.entries()) {
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

const frameSlots = Vue.computed(() => {
  return currentFrameDetail.value?.slots ?? [];
});

async function refreshDashboardFromForeground() {
  if (foregroundRefreshPromise) {
    await foregroundRefreshPromise;
    return;
  }

  foregroundRefreshPromise = (async () => {
    try {
      if (bot.isReady) {
        try {
          await bot.refreshState();
        } catch (error) {
          console.warn('[Mining Dashboard] Bot refresh failed during app resume', error);
        }
      }

      await myMiningSeats.refresh();

      await updateSliderFrame(sliderFrameIndex.value);

      if (currentFrame.value.id === myMiningSeats.latestFrameId) {
        await refreshLiveAuctionCloseTick(currentFrame.value.id);
        await refreshLiveFrameDetail();
      } else {
        await refreshPendingHistoricalFrameDetail();
      }
    } catch (error) {
      console.error('[Mining Dashboard] Failed to refresh after app resume', error);
    } finally {
      foregroundRefreshPromise = null;
    }
  })();

  await foregroundRefreshPromise;
}

async function refreshLiveAuctionCloseTick(frameId: number): Promise<void> {
  try {
    const client = await getMainchainClient(true);
    const tick = await mining.fetchTickAtStartOfAuctionClosing(client);

    if (frameId !== myMiningSeats.latestFrameId || currentFrame.value?.id !== frameId) {
      return;
    }

    liveAuctionCloseTick.value = { frameId, tick };
  } catch (error) {
    console.error(`[Mining Dashboard] Failed to refresh live auction close tick for frame ${frameId}`, error);
  }
}

function onWindowFocus() {
  void refreshDashboardFromForeground();
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    return;
  }

  void refreshDashboardFromForeground();
}

async function loadFrameDetail(frameId: number): Promise<IMiningFrameDetail> {
  const canCacheFrame = frameId < myMiningSeats.latestFrameId && frameId <= finalizedFrameId.value;
  const cached = canCacheFrame ? historicalFrameDetailByFrameId.get(frameId) : null;
  if (cached) return cached;

  const pending = pendingFrameDetailByFrameId.get(frameId);
  if (pending) return pending;

  const request = (async () => {
    const client = await bot.getClient();
    const detail = await client.fetch('/mining-frame', frameId);
    if (canCacheFrame) {
      historicalFrameDetailByFrameId.set(frameId, detail);
    }
    return detail;
  })().finally(() => {
    pendingFrameDetailByFrameId.delete(frameId);
  });

  pendingFrameDetailByFrameId.set(frameId, request);
  return request;
}

async function loadLiveFrameDetailFromChain(frameId: number): Promise<IMiningFrameDetail> {
  const client = await getMainchainClient(true);
  const [winningBids, slots, totalBidCount, expectedAuctionCloseTick] = await Promise.all([
    Mining.fetchWinningBids(client),
    mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address),
    client.query.miningSlot.historicalBidsPerSlot().then(x => x[0]?.bidsCount.toNumber() ?? 0),
    mining.fetchTickAtStartOfAuctionClosing(client),
  ]);

  return {
    frameId,
    totalBidCount,
    myLastBidMicrogons: bot.state?.lastBid?.microgonsPerSeat,
    winningBids,
    slots,
    expectedAuctionCloseTick,
  };
}

function prefetchHistoricalFrameDetail(frameId: number) {
  if (frameId < 1 || frameId >= myMiningSeats.latestFrameId) {
    return;
  }

  if (historicalFrameDetailByFrameId.has(frameId) || pendingFrameDetailByFrameId.has(frameId)) {
    return;
  }

  void loadFrameDetail(frameId).catch(error => {
    console.error(`[Mining Dashboard] Failed to prefetch historical frame detail for frame ${frameId}`, error);
  });
}

async function updateSliderFrame(newFrameIndex: number) {
  const lastIndex = Math.max(myMiningSeats.frames.length - 1, 0);
  const nextFrameIndex = Math.min(Math.max(newFrameIndex, 0), lastIndex);
  const nextFrame = myMiningSeats.frames[nextFrameIndex];
  if (!nextFrame) return;

  currentFrame.value = nextFrame;
  const frameId = currentFrame.value.id;

  myMiningSeats.selectFrameId(frameId, true);

  if (frameId === myMiningSeats.latestFrameId) {
    loadingFrameId.value = null;
    if (latestLiveFrameDetail.value?.frameId === frameId) {
      frameDetail.value = latestLiveFrameDetail.value;
    }
    void refreshLiveFrameDetail();
    return;
  }

  await loadHistoricalFrameDetail(frameId);
}

Vue.watch(
  () => myMiningSeats.frames,
  () => {
    loadChartData();
    void updateSliderFrame(sliderFrameIndex.value);
  },
  { deep: true },
);

async function refreshLiveFrameDetail() {
  if (!isSelectedLiveFrame.value) return;
  const frameId = myMiningSeats.latestFrameId;
  const requestId = ++frameDetailRequestId;
  let hasFallbackDetail = false;

  if (liveAuctionCloseTick.value?.frameId !== frameId) {
    void refreshLiveAuctionCloseTick(frameId);
  }

  if (!bot.isReady && frameDetail.value?.frameId !== frameId) {
    void loadLiveFrameDetailFromChain(frameId)
      .then(detail => {
        if (requestId !== frameDetailRequestId || !isSelectedLiveFrame.value || currentFrame.value?.id !== frameId) {
          return;
        }

        hasFallbackDetail = true;
        latestLiveFrameDetail.value = detail;
        frameDetail.value = detail;
      })
      .catch(error => {
        console.error(`[Mining Dashboard] Failed to load live frame fallback for frame ${frameId}`, error);
      });
  }

  try {
    const detail = await loadFrameDetail(frameId);
    if (requestId !== frameDetailRequestId || !isSelectedLiveFrame.value || currentFrame.value?.id !== frameId) {
      return;
    }
    latestLiveFrameDetail.value = detail;
    frameDetail.value = detail;
  } catch (error) {
    if (hasFallbackDetail) {
      return;
    }

    console.error(`[Mining Dashboard] Failed to refresh live frame detail for frame ${frameId}`, error);
  }
}

async function refreshPendingHistoricalFrameDetail() {
  const frameId = currentFrame.value.id;
  if (frameId >= myMiningSeats.latestFrameId) return;

  await loadHistoricalFrameDetail(frameId);
}

async function loadHistoricalFrameDetail(frameId: number) {
  const cachedDetail = historicalFrameDetailByFrameId.get(frameId);
  if (cachedDetail) {
    if (currentFrame.value?.id !== frameId) return;

    loadingFrameId.value = null;
    frameDetail.value = cachedDetail;
    prefetchHistoricalFrameDetail(frameId - 1);
    return;
  }

  loadingFrameId.value = frameId;

  const requestId = ++frameDetailRequestId;
  try {
    const detail = await loadFrameDetail(frameId);
    if (requestId !== frameDetailRequestId || currentFrame.value?.id !== frameId) {
      return;
    }

    frameDetail.value = detail;
    prefetchHistoricalFrameDetail(frameId - 1);
  } catch (error) {
    if (requestId !== frameDetailRequestId || currentFrame.value?.id !== frameId) {
      return;
    }

    console.error(`[Mining Dashboard] Failed to load historical frame detail for frame ${frameId}`, error);
  } finally {
    if (requestId === frameDetailRequestId && loadingFrameId.value === frameId) {
      loadingFrameId.value = null;
    }
  }
}

Vue.watch(isSelectedLiveFrame, isLiveFrame => {
  lastBlockMinerAddress.value = isLiveFrame ? blockWatch.latestHeaders.at(-1)?.author : undefined;
});

Vue.onMounted(() => {
  void myMiningSeats.subscribeToDashboard();
  void myMiningSeats.subscribeToActivity();
  loadChartData();
  void updateSliderFrame(sliderFrameIndex.value);

  void blockWatch
    .start()
    .then(() => {
      lastBlockMinerAddress.value = isSelectedLiveFrame.value ? blockWatch.bestBlockHeader.author : undefined;
      stopBestBlockSubscription = blockWatch.events.on('best-blocks', blocks => {
        if (!isSelectedLiveFrame.value) {
          return;
        }

        lastBlockMinerAddress.value = blocks.at(-1)?.author;
      });
    })
    .catch(error => {
      console.error('[Mining Dashboard] Failed to subscribe to best blocks', error);
    });

  botEmitter.on('updated-bids-data', refreshLiveFrameDetail);
  botEmitter.on('updated-cohort-data', refreshLiveFrameDetail);
  botEmitter.on('updated-server-state', refreshPendingHistoricalFrameDetail);
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

Vue.onUnmounted(() => {
  myMiningSeats.unsubscribeFromDashboard();
  myMiningSeats.unsubscribeFromActivity();
  stopBestBlockSubscription?.();
  botEmitter.off('updated-bids-data', refreshLiveFrameDetail);
  botEmitter.off('updated-cohort-data', refreshLiveFrameDetail);
  botEmitter.off('updated-server-state', refreshPendingHistoricalFrameDetail);
  window.removeEventListener('focus', onWindowFocus);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  frameSliderRef.value = null;
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
