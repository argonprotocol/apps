<!-- prettier-ignore -->
<template>
  <TooltipProvider :disableHoverableContent="true" class="flex flex-col h-full">
    <ServerConnectionStatus v-if="!bot.isReady && config.isServerInstalling" featureName="Mining" isBlocking>
      <template #icon><MiningIcon class="h-full w-full" /></template>
    </ServerConnectionStatus>

    <div data-testid="MiningDashboard" :class="myMiningSeats.isLoaded ? '' : 'opacity-30 pointer-events-none'" class="flex min-w-0 flex-col h-full pr-2.5 gap-y-2 justify-stretch grow">
      <span data-testid="TotalBlocksMined" :data-value="totalBlocksMined" class="sr-only">{{ totalBlocksMined }}</span>

      <section class="flex flex-row gap-x-2 h-[14%]">
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span :class="isHistoricalMetricsPending ? 'opacity-75' : ''">{{ visibleMiningMetrics ? numeral(visibleMiningMetrics.global.framesCompleted).format('0,0.[00]') : '--' }}</span>
            <label>Frame{{ visibleMiningMetrics?.global.framesCompleted === 1 ? '' : 's' }} Completed</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="start" :collisionPadding="9" class="bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of frames that you've mined over the previous year.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span :class="isHistoricalMetricsPending ? 'opacity-75' : ''">{{ visibleMiningMetrics ? numeral(visibleMiningMetrics.global.framesRemaining).format('0,0.[00]') : '--' }}</span>
            <label>Frame{{ visibleMiningMetrics?.global.framesRemaining === 1 ? '' : 's' }} Remaining</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The number of future frames for which you own mining rights.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span v-if="visibleMiningMetrics" :class="isHistoricalMetricsPending ? 'opacity-75' : ''">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(visibleMiningMetrics.returnSummary.investedCost).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <span v-else :class="isHistoricalMetricsPending ? 'opacity-75' : ''">--</span>
            <label>Invested Cost</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="center" :collisionPadding="9" class="text-center bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            The bid costs and transaction fees for the mining terms included in Mining RTD.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span v-if="visibleMiningMetrics" :class="isHistoricalMetricsPending ? 'opacity-75' : ''">
              {{ currency.symbol
              }}{{ microgonToMoneyNm(visibleMiningMetrics.returnSummary.returnAmount ?? 0n).formatIfElse('< 100', '0.00', '0,0') }}
            </span>
            <span v-else :class="isHistoricalMetricsPending ? 'opacity-75' : ''">--</span>
            <label>Profit to Date</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Value and income earned to date, less invested cost, for the mining terms included in Mining RTD.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span v-if="visibleMiningMetrics?.returnSummary.percent !== undefined" :class="isHistoricalMetricsPending ? 'opacity-75' : ''">
              {{ numeral(visibleMiningMetrics.returnSummary.percent).formatIfElseCapped('< 100', '0.[00]', '0,0', 9_999) }}%
            </span>
            <span v-else :class="isHistoricalMetricsPending ? 'opacity-75' : ''">--</span>
            <label>Mining RTD</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            Your return to date across mining terms and mining ARGNOT positions.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
      </section>

      <div v-if="isHistoricalMetricsPending" class="flex items-center gap-1.5 px-2.5 text-xs text-slate-500">
        <span v-if="bot.state?.historyError">Mining earnings history could not be loaded.</span>
        <span v-else-if="bot.historicalDbError">Past mining earnings are temporarily out of date.</span>
        <span v-else>Loading past mining earnings: {{ numeral(historicalMetricsProgress).format('0.0') }}%</span>
        <TooltipRoot>
          <TooltipTrigger as="span" tabindex="0" aria-label="About mining earnings history" class="inline-flex cursor-help text-slate-400 hover:text-slate-600">
            <InformationCircleIcon class="size-4" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent side="top" align="center" :sideOffset="8" :collisionPadding="9" :style="floatingZIndex" class="max-w-xs rounded-md border border-gray-800/20 bg-white p-3 text-sm text-slate-700 shadow-2xl">
              <template v-if="bot.state?.historyError">Something failed during the restoration of your mining earnings history. If you'd like help, you can use the Troubleshoot link to download a debugging package and send it to a Core Developer on Discord.</template>
              <template v-else-if="bot.historicalDbError">The desktop will retry loading older mining records when the bot updates.</template>
              <template v-else>These totals will update when older earnings finish loading.</template>
              <TooltipArrow :width="16" :height="8" class="-mt-px fill-white stroke-[0.5px] stroke-gray-800/20" />
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
        <button v-if="bot.state?.historyError" type="button" class="ml-1 cursor-pointer text-argon-600 underline" @click="basicEmitter.emit('openTroubleshootingOverlay', { screen: 'overview' })">Troubleshoot</button>
      </div>

      <section class="flex min-w-0 flex-row gap-x-2.5 grow">
        <div class="flex min-w-0 flex-col grow gap-y-2">
          <section box class="flex flex-col grow text-center px-2">
            <header class="flex flex-row justify-between text-xl font-bold py-2 px-2 text-slate-900/80 border-b border-slate-400/30 select-none">
              <span class="flex flex-row items-center" :title="'Frame #' + currentFrame.id">
                <span>{{ currentFrameStartDate }} to {{ currentFrameEndDate }}</span>
                <span v-if="myMiningSeats.selectedFrameId > myMiningSeats.latestFrameId - 10" class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
                <span
                  v-if="isFrameDetailLoading"
                  class="ml-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500/55 animate-pulse">
                  Updating
                </span>
              </span>
              <div class="flex flex-row items-center gap-x-3">
                <button @click="openBotEditOverlay" class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80">
                  Settings
                </button>
                <div class="w-px h-8/12 bg-slate-600/30" />
                <button
                  class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80"
                  @click="basicEmitter.emit('openMiningBiddingBotOverlay')"
                >
                  Bidding Bot
                </button>
                <div class="w-px h-8/12 bg-slate-600/30" />
                <button
                  class="flex flex-row items-center font-light text-base cursor-pointer group hover:opacity-80"
                  @click="basicEmitter.emit('openMiningActiveSeatsOverlay')"
                >
                  Active Seats
                </button>
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
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section box class="relative flex flex-col h-[35%] !pb-0.5 px-2">
            <div v-if="sliderFrameIndex < 0" class="flex h-full items-center justify-center text-sm text-slate-500">
              Historical chart loading
            </div>
            <FrameSlider v-else
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
import type { IChartItem } from '../../interfaces/IChartItem.ts';
import type { IDashboardGlobalStats } from '../../interfaces/IMiningSeatStats.ts';
import type { IFinancialReturnSummary } from '../../interfaces/IFinancialPosition.ts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';

// Keep dashboard state warm across unmounts so switching tabs doesn't cold-start the view.
const chartItems = Vue.ref<IChartItem[]>([]);
const frameDetail = Vue.ref<IMiningFrameDetail | null>(null);
const latestLiveFrameDetail = Vue.ref<IMiningFrameDetail | null>(null);
const loadingFrameId = Vue.ref<number | null>(null);
const historicalFrameDetailByFrameId = new Map<number, IMiningFrameDetail>();
const pendingFrameDetailByFrameId = new Map<number, Promise<IMiningFrameDetail>>();
let frameDetailRequestId = 0;
const lastCompleteMiningMetrics = Vue.shallowRef<{
  owner: object;
  account: string;
  global: IDashboardGlobalStats;
  returnSummary: IFinancialReturnSummary;
} | null>(null);

dayjs.extend(relativeTime);
dayjs.extend(utc);
</script>

<script setup lang="ts">
import { BigNumber } from 'bignumber.js';
import { Mining } from '@argonprotocol/apps-core';
import { getMyMiningSeats } from '../../stores/myMiningSeats.ts';
import { getCurrency } from '../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { TICK_MILLIS } from '../../lib/Env.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import FrameSlider from '../../components/FrameSlider.vue';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipArrow, TooltipPortal } from 'reka-ui';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import CountdownClock from '../../components/CountdownClock.vue';
import MiningSeats from './components/MiningSeats.vue';
import { getBlockWatch, getMainchainClient, getMining, getMiningFrames } from '../../stores/mainchain.ts';
import { botEmitter } from '../../lib/Bot.ts';
import { getBot } from '../../stores/bot.ts';
import { getConfig } from '../../stores/config.ts';
import { useWallets } from '../../stores/wallets.ts';
import { useFinancials } from '../../stores/financials.ts';
import MiningIcon from '../../assets/mining.svg?component';
import ServerConnectionStatus from '../../components/ServerConnectionStatus.vue';

const myMiningSeats = getMyMiningSeats();
const currency = getCurrency();
const bot = getBot();
const config = getConfig();
const blockWatch = getBlockWatch();
const mining = getMining();
const miningFrames = getMiningFrames();
const wallets = useWallets();
const financials = useFinancials();
const floatingZIndex = useFloatingZIndex();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isHistoricalMetricsPending = Vue.computed(
  () =>
    Boolean(bot.state?.isSyncing || bot.state?.historyError || bot.historicalDbError) ||
    Boolean(bot.state?.oldestFrameIdToSync && bot.historicalDbProgress === null) ||
    (bot.historicalDbProgress !== null && bot.historicalDbProgress < 100),
);
const historicalMetricsProgress = Vue.computed(() => bot.syncProgress);
const currentFrame = Vue.computed(() => ({
  id: myMiningSeats.selectedFrameId,
  firstTick:
    myMiningSeats.frames.find(frame => frame.id === myMiningSeats.selectedFrameId)?.firstTick ??
    miningFrames.framesById?.[myMiningSeats.selectedFrameId]?.frameStartTick ??
    0,
}));

const frameSliderRef = Vue.ref<InstanceType<typeof FrameSlider> | null>(null);
const lastBlockMinerAddress = Vue.ref<string>();
const liveAuctionCloseTick = Vue.ref<{ frameId: number; tick: number } | null>(null);

let foregroundRefreshPromise: Promise<void> | null = null;
let stopBestBlockSubscription: (() => void) | null = null;

const sliderFrameIndex = Vue.computed(() => {
  if (myMiningSeats.selectedFrameId === myMiningSeats.latestFrameId) return myMiningSeats.frames.length - 1;
  return myMiningSeats.frames.findIndex(frame => frame.id === myMiningSeats.selectedFrameId);
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

const miningReturnSummary = Vue.computed(() => {
  return financials.financialPositionAggregate.groupSummaries.mining.returnSummary;
});

Vue.watchEffect(
  () => {
    if (!bot.isReady || !myMiningSeats.isLoaded || isHistoricalMetricsPending.value) return;
    lastCompleteMiningMetrics.value = {
      owner: bot,
      account: wallets.miningBotWallet.address,
      global: { ...myMiningSeats.global },
      returnSummary: { ...miningReturnSummary.value },
    };
  },
  { flush: 'sync' },
);

const visibleMiningMetrics = Vue.computed(() => {
  if (!isHistoricalMetricsPending.value) {
    return { global: myMiningSeats.global, returnSummary: miningReturnSummary.value };
  }
  const lastComplete = lastCompleteMiningMetrics.value;
  return lastComplete?.owner === bot && lastComplete.account === wallets.miningBotWallet.address ? lastComplete : null;
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
  if (!currentFrame.value.firstTick) return '-----';
  const frameEndTick = miningFrames.getTickEnd(currentFrame.value.id);
  if (!frameEndTick) {
    return '-----';
  }
  const date = dayjs.utc(frameEndTick * TICK_MILLIS);
  return date.local().add(1, 'minute').format('MMMM D, h:mm A');
});

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
    const client = await getMainchainClient(false);
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
  const client = await getMainchainClient(false);
  const [winningBids, slots, totalBidCount, expectedAuctionCloseTick] = await Promise.all([
    Mining.fetchWinningBids(client),
    mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address),
    client.query.miningSlot.historicalBidsPerSlot().then(x => x[0]?.bidsCount ?? 0),
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

function updateSliderFrame(newFrameIndex: number, isUserAction = false) {
  // The right edge selects live bidding even before this frame's earnings have been imported.
  if (isUserAction && newFrameIndex === myMiningSeats.frames.length - 1) {
    myMiningSeats.selectFrameId(myMiningSeats.latestFrameId, { isUserAction, skipDashboardUpdate: true });
    return;
  }
  const nextFrame = myMiningSeats.frames[newFrameIndex];
  if (!nextFrame) return;
  myMiningSeats.selectFrameId(nextFrame.id, { isUserAction, skipDashboardUpdate: true });
}

Vue.watch(() => myMiningSeats.frames, loadChartData, { deep: true });

Vue.watch(
  () => myMiningSeats.selectedFrameId,
  frameId => {
    if (!frameId) return;
    if (frameId === myMiningSeats.latestFrameId) {
      loadingFrameId.value = null;
      void refreshLiveFrameDetail();
    } else {
      void loadHistoricalFrameDetail(frameId);
    }
  },
  { immediate: true },
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
  if (frameId !== myMiningSeats.selectedFrameId) return;
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

Vue.watch(() => myMiningSeats.financialRevision, refreshLiveFrameDetail);

Vue.onMounted(() => {
  void myMiningSeats.subscribeToDashboard({ selectLatestFrame: true });
  void myMiningSeats.subscribeToActivity();
  loadChartData();

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

  botEmitter.on('updated-server-state', refreshPendingHistoricalFrameDetail);
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

Vue.onUnmounted(() => {
  myMiningSeats.unsubscribeFromDashboard();
  myMiningSeats.unsubscribeFromActivity();
  stopBestBlockSubscription?.();
  botEmitter.off('updated-server-state', refreshPendingHistoricalFrameDetail);
  window.removeEventListener('focus', onWindowFocus);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  frameSliderRef.value = null;
});
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply min-h-20 min-w-0 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
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
