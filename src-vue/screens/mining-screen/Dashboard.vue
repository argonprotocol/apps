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
            The bid costs and transaction fees for the mining terms included in Mining {{ config.returnMetric }}.
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
            Value and income earned to date, less invested cost, for the mining terms included in your returns.
            <TooltipArrow :width="27" :height="15" class="fill-white stroke-[0.5px] stroke-gray-800/20 -mt-px" />
          </TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as="div" box stat-box class="flex flex-col w-[20%] !py-4 group">
            <span v-if="visibleMiningMetrics?.returnSummary.percent !== undefined" :class="isHistoricalMetricsPending ? 'opacity-75' : ''">
              <Returns :returns="visibleMiningMetrics.returnSummary" :showLabel="false" />
            </span>
            <span v-else :class="isHistoricalMetricsPending ? 'opacity-75' : ''">--</span>
            <label>Mining {{ config.returnMetric }}</label>
          </TooltipTrigger>
          <TooltipContent side="bottom" :sideOffset="-10" align="end" :collisionPadding="9" class="text-right bg-white border border-gray-800/20 rounded-md shadow-2xl z-50 p-4 w-xs text-slate-900/60">
            <template v-if="config.returnMetric === 'APR'">Your annualized return without compounding</template>
            <template v-else-if="config.returnMetric === 'APY'">Your annualized return assuming reinvestment at the same rate</template>
            <template v-else>Your return to date</template>
            across mining terms and mining ARGNOT positions.
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
                <span class="inline-block rounded-full bg-green-500/80 w-2.5 h-2.5 ml-2"></span>
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
            <div class="relative flex flex-col h-full grow">
              <div class="flex h-full w-full grow flex-col pt-4 px-2">
                <div class="flex w-full grow pt-4 px-2">
                  <MiningSeats
                    isLiveFrame
                    :frameId="currentFrame.id"
                    :lastBlockMinerAddress="lastBlockMinerAddress"
                    :frameSlots="frameSlots" />
                </div>
                <div class="pt-4 pb-3">
                  <div class="mb-2 flex items-center gap-x-3 text-center">
                    <span class="h-px grow bg-slate-400/30"></span>
                  </div>
                  <div class="grid grid-cols-4 gap-x-4 gap-y-5 text-center text-base leading-none text-slate-700/80 pt-3">
                    <div>{{ numeral(currentFrameDetail?.totalBidCount ?? 0).format('0,0') }} Bids Placed this Frame</div>
                    <div>{{ formatBidAmount(highestWinningBid) }} Is the Highest Bid</div>
                    <div v-if="liveBotState?.isBidInProgress">Bid in Progress</div>
                    <div v-else-if="liveNextBid">{{ formatBidAmount(liveNextBid.microgonsPerSeat) }} Is Your Next Bid</div>
                    <div v-else>No Bid Planned</div>
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
                    <div v-else-if="liveBotState?.isBidInProgress">Waiting for Bid Result</div>
                    <div v-else-if="liveBotState?.lastBid && !liveBotState.lastBid.isFinalized">Awaiting Bid Finalization</div>
                    <div v-else>No Rebid Planned</div>
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
            <div v-if="latestChartFrameIndex < 0" class="flex h-full items-center justify-center text-sm text-slate-500">
              Historical chart loading
            </div>
            <FrameSlider v-else
              :chartItems="chartItems"
              :selectedIndex="latestChartFrameIndex"
              @inspectFrame="inspectedFrameId = $event"
              :navigationDisabled="true">
              <template #tooltipHeader="{ item }">
                {{ dayjs.utc(chartFramesById[item.id].firstTick * TICK_MILLIS).local().format('MMMM D, h:mm A') }} to
                {{ dayjs.utc((miningFrames.getTickEnd(item.id) + 1) * TICK_MILLIS).local().format('MMMM D, h:mm A') }}
              </template>
              <template #tooltip="{ item }">
                <div v-if="chartFramesById[item.id]" class="space-y-3 whitespace-nowrap">
                  <div class="grid grid-cols-3 divide-x divide-slate-300 border-b border-slate-200 py-1 pb-4 text-center">
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">Earnings</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        {{ currency.recordsByKey.ARGN.symbol }}{{
                          microgonToArgonNm(chartFramesById[item.id].microgonValueOfRewards).formatIfElse('< 100', '0,0.00', '0,0')
                        }}
                      </div>
                      <p class="mt-1 text-slate-500">
                        <template v-if="item.score === null || (item.id === myMiningSeats.latestFrameId && chartFramesById[item.id].progress < 100)">In progress</template>
                        <template v-else>
                          <template v-if="chartFramesById[item.id].profitPct >= 9_999">9,999%+</template>
                          <template v-else-if="chartFramesById[item.id].profitPct > 0 && chartFramesById[item.id].profitPct < 0.1">&lt;0.1%</template>
                          <template v-else>{{ numeral(chartFramesById[item.id].profitPct).format('0,0.[0]') }}%</template>
                          return
                        </template>
                      </p>
                    </div>
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">Active Seats</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        {{ numeral(chartFramesById[item.id].seatCountActive).format('0,0') }}
                      </div>
                      <p class="mt-1 text-slate-500">
                        <template v-if="inspectedNetworkSeatCount !== undefined">of {{ numeral(inspectedNetworkSeatCount).format('0,0') }} network</template>
                        <template v-else>&mdash;</template>
                      </p>
                    </div>
                    <div class="px-4">
                      <header class="font-semibold text-slate-500">New Seats Won</header>
                      <div class="text-argon-600 pt-1 font-mono text-3xl font-bold">
                        <template v-if="inspectedWinningBids && inspectedFrameDetail && (item.id < myMiningSeats.latestFrameId || inspectedFrameDetail.auctionCloseTick)">
                          {{ numeral(inspectedWinningBids.length).format('0,0') }}
                        </template>
                        <template v-else>&mdash;</template>
                      </div>
                      <p class="mt-1 text-slate-500">
                        <template v-if="item.id === myMiningSeats.latestFrameId && inspectedFrameDetail && !inspectedFrameDetail.auctionCloseTick">Auction open</template>
                        <template v-else-if="inspectedFrameDetail?.auctionSeatCount !== undefined">of {{ numeral(inspectedFrameDetail.auctionSeatCount).format('0,0') }} in auction</template>
                        <template v-else>&mdash;</template>
                      </p>
                    </div>
                  </div>
                  <div>
                    <h4 class="mb-2 font-semibold text-slate-700">Earnings Breakdown</h4>
                    <div class="space-y-1">
                      <p class="flex justify-between">
                        <span class="text-slate-500">Tokens Mined</span>
                        <span>
                          {{ microgonToArgonNm(chartFramesById[item.id].microgonsMinedTotal).format('0,0.[00]') }} ARGN +
                          {{ micronotToArgonotNm(chartFramesById[item.id].micronotsMinedTotal).format('0,0.[00]') }} ARGNOT
                        </span>
                      </p>
                      <p class="flex justify-between">
                        <span class="text-slate-500">Tokens Minted</span>
                        <span>{{ microgonToArgonNm(chartFramesById[item.id].microgonsMintedTotal).format('0,0.[00]') }} ARGN</span>
                      </p>
                    </div>
                  </div>
                  <div class="border-t border-slate-200 pt-3">
                    <h4 class="mb-2 font-semibold text-slate-700">Result of Day's Auction</h4>
                    <div class="space-y-2">
                      <p class="flex justify-between gap-6">
                        <span class="text-slate-500">Winning Bid Range</span>
                        <span class="text-right">
                          <template v-if="inspectedWinningBidRange">
                            <template v-if="inspectedWinningBidRange.minimum !== undefined && inspectedWinningBidRange.maximum !== undefined">
                              {{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(inspectedWinningBidRange.minimum).format('0,0.00') }}–{{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(inspectedWinningBidRange.maximum).format('0,0.00') }} / seat
                            </template>
                            <template v-else>None</template>
                          </template>
                          <template v-else>&mdash;</template>
                        </span>
                      </p>
                      <p class="flex justify-between gap-6">
                        <span class="text-slate-500">Your Bid Attempts</span>
                        <span class="text-right">
                          <template v-if="inspectedBidActivity?.submittedBidCount !== undefined">{{ numeral(inspectedBidActivity.submittedBidCount).format('0,0') }}</template>
                          <template v-else>&mdash;</template>
                        </span>
                      </p>
                      <p class="flex justify-between gap-6">
                        <span class="text-slate-500">Your Max Bid</span>
                        <span class="text-right">
                          <template v-if="inspectedBidActivity?.maximumMicrogons !== undefined">
                            {{ currency.recordsByKey.ARGN.symbol }}{{ microgonToArgonNm(inspectedBidActivity.maximumMicrogons).format('0,0.00') }} / seat
                          </template>
                          <template v-else-if="inspectedBidActivity">None</template>
                          <template v-else>&mdash;</template>
                        </span>
                      </p>
                    </div>
                  </div>
                </div>
              </template>
            </FrameSlider>
          </section>
        </div>
      </section>
    </div>
  </TooltipProvider>
</template>

<script lang="ts">
import * as Vue from 'vue';
import Returns from '../../components/Returns.vue';
import type { IHistoryFile, IMiningFrameDetail } from '@argonprotocol/apps-core';
import type { IChartItem } from '../../interfaces/IChartItem.ts';
import type { IDashboardGlobalStats } from '../../interfaces/IMiningSeatStats.ts';
import type { IFinancialReturnSummary } from '../../interfaces/IFinancialPosition.ts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';

// Keep dashboard state warm across unmounts so switching tabs doesn't cold-start the view.
const chartItems = Vue.ref<IChartItem[]>([]);
const frameDetail = Vue.ref<IMiningFrameDetail | null>(null);
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
import { watchDebounced } from '@vueuse/core';
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
import { getBot } from '../../stores/bot.ts';
import { getConfig } from '../../stores/config.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
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
const walletKeys = getWalletKeys();
const financials = useFinancials();
const floatingZIndex = useFloatingZIndex();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isHistoricalMetricsPending = Vue.computed(
  () =>
    Boolean(bot.state?.isSyncing || bot.state?.historyError || bot.historicalDbError) ||
    Boolean(bot.state?.oldestFrameIdToSync && bot.historicalDbProgress === null) ||
    (bot.historicalDbProgress !== null && bot.historicalDbProgress < 100),
);
const historicalMetricsProgress = Vue.computed(() => bot.syncProgress);
const currentFrame = Vue.computed(() => ({
  id: myMiningSeats.latestFrameId,
  firstTick:
    myMiningSeats.frames.find(frame => frame.id === myMiningSeats.latestFrameId)?.firstTick ??
    miningFrames.framesById?.[myMiningSeats.latestFrameId]?.frameStartTick ??
    0,
}));

const lastBlockMinerAddress = Vue.ref<string>();
const liveAuctionCloseTick = Vue.ref<{ frameId: number; tick: number } | null>(null);

let foregroundRefreshPromise: Promise<void> | null = null;
let stopBestBlockSubscription: (() => void) | null = null;

const latestChartFrameIndex = Vue.computed(() => myMiningSeats.frames.length - 1);
const liveBotState = Vue.computed(() => {
  if (bot.state?.currentFrameId !== myMiningSeats.latestFrameId) return;
  return bot.state;
});
const finalizedFrameId = Vue.computed(() => {
  return bot.state?.finalizedFrameId ?? 0;
});
const currentFrameDetail = Vue.computed(() => {
  if (frameDetail.value?.frameId === myMiningSeats.latestFrameId) return frameDetail.value;
  return null;
});
const auctionBids = Vue.computed(() => myMiningSeats.allWinningBids ?? []);

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

const myLastBidMicrogons = Vue.computed(() => {
  return liveBotState.value?.lastBid?.microgonsPerSeat ?? currentFrameDetail.value?.myLastBidMicrogons ?? null;
});
const liveNextBid = Vue.computed(() => {
  if (liveBotState.value?.isBidInProgress) return null;
  return liveBotState.value?.nextBid ?? null;
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

    if (frame.progress < 100) {
      if (frame.seatCostTotalFramed > 0n && frame.microgonValueOfRewards === 0n) item.score = null;
    }

    items.push(item);
  }

  for (const [index, item] of items.entries()) {
    item.next = items[index + 1];
  }

  chartItems.value = items;
}

const chartFramesById = Vue.computed(() => Object.fromEntries(myMiningSeats.frames.map(frame => [frame.id, frame])));
const inspectedFrameId = Vue.ref<number>();
const inspectedHistoricalDetail = Vue.shallowRef<IMiningFrameDetail>();
const inspectedFrameDetail = Vue.computed(() => {
  if (inspectedFrameId.value === myMiningSeats.latestFrameId) return currentFrameDetail.value;
  const cached = historicalFrameDetailByFrameId.get(inspectedFrameId.value ?? -1);
  if (cached) return cached;
  if (inspectedHistoricalDetail.value?.frameId === inspectedFrameId.value) return inspectedHistoricalDetail.value;
});
const inspectedNetworkSeatCount = Vue.computed(() => {
  const slots = inspectedFrameDetail.value?.slots;
  if (slots?.length !== 10) return;
  return slots.reduce((total, slot) => total + slot.seats.filter(seat => seat.miner).length, 0);
});
const ourBidAddresses = Vue.shallowRef<Set<string>>();
const inspectedWinningBids = Vue.computed(() => {
  const detail = inspectedFrameDetail.value;
  const addresses = ourBidAddresses.value;
  if (!detail || !addresses) return;
  return detail.winningBids.filter(bid => addresses.has(bid.address));
});

Vue.watch(
  () => myMiningSeats.financialRevision,
  async () => {
    const subaccounts = await walletKeys.getMiningBotSubaccounts();
    ourBidAddresses.value = new Set(Object.keys(subaccounts));
  },
  { immediate: true },
);

const bidHistoryByFrame = new Map<number, Promise<IHistoryFile>>();
const inspectedBidHistory = Vue.shallowRef<{ frameId: number; history: IHistoryFile }>();
Vue.watch([() => bot.state?.isSyncing, () => bot.state?.historyError], () => bidHistoryByFrame.clear());
const inspectedBidActivity = Vue.computed(() => {
  const record = inspectedBidHistory.value;
  const history = record?.frameId === inspectedFrameId.value ? record?.history : undefined;
  return Mining.summarizeBidHistory(history, inspectedFrameDetail.value?.totalBidCount);
});

const inspectedWinningBidRange = Vue.computed(() => {
  const bids = inspectedFrameDetail.value?.winningBids;
  if (!bids) return;

  let minimum: bigint | undefined;
  let maximum: bigint | undefined;
  for (const bid of bids) {
    const amount = bid.microgonsPerSeat;
    if (amount === undefined) return;
    if (minimum === undefined || amount < minimum) minimum = amount;
    if (maximum === undefined || amount > maximum) maximum = amount;
  }
  return { minimum, maximum };
});
watchDebounced(
  [
    inspectedFrameId,
    () => bot.isReady,
    () => myMiningSeats.latestFrameId,
    () => bot.state?.lastBid?.isFinalized,
    () => bot.state?.isSyncing,
  ],
  async ([frameId], _previous, onCleanup) => {
    if (frameId === undefined || frameId < 1 || !bot.isReady) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    let detailRequest: Promise<IMiningFrameDetail | null>;
    if (frameId === myMiningSeats.latestFrameId) {
      detailRequest = Promise.resolve(currentFrameDetail.value);
    } else {
      detailRequest = loadFrameDetail(frameId);
    }

    const [historyResult, detailResult] = await Promise.allSettled([loadBidHistory(frameId), detailRequest]);
    if (cancelled || inspectedFrameId.value !== frameId) return;

    if (historyResult.status === 'fulfilled') {
      const history = historyResult.value;
      inspectedBidHistory.value = { frameId, history };
    } else {
      console.warn('[Mining Dashboard] Bid activity is unavailable', historyResult.reason);
    }

    if (detailResult.status === 'fulfilled') {
      inspectedHistoricalDetail.value = detailResult.value ?? undefined;
    } else {
      console.warn('[Mining Dashboard] Historical auction details are unavailable', detailResult.reason);
    }

    // Warm only the adjacent historical frames; shared requests also cover rapid arrow navigation.
    for (const adjacentFrameId of [frameId - 1, frameId + 1]) {
      if (!chartFramesById.value[adjacentFrameId] || adjacentFrameId >= myMiningSeats.latestFrameId) continue;
      void Promise.allSettled([loadBidHistory(adjacentFrameId), loadFrameDetail(adjacentFrameId)]);
    }
  },
  { debounce: 150 },
);

async function loadBidHistory(frameId: number): Promise<IHistoryFile> {
  const cached = bidHistoryByFrame.get(frameId);
  if (cached) return cached;

  const canCache = frameId < finalizedFrameId.value && !bot.state?.isSyncing && !bot.state?.historyError;
  const request = bot.getClient().then(client => client.fetch('/history', frameId + 1));
  bidHistoryByFrame.set(frameId, request);

  try {
    return await request;
  } catch (error) {
    if (bidHistoryByFrame.get(frameId) === request) bidHistoryByFrame.delete(frameId);
    throw error;
  } finally {
    if (!canCache && bidHistoryByFrame.get(frameId) === request) bidHistoryByFrame.delete(frameId);
  }
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

      await refreshLiveAuctionCloseTick(currentFrame.value.id);
      await refreshLiveFrameDetail();
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

    if (frameId !== myMiningSeats.latestFrameId) {
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
  const [winningBids, slots, totalBidCount, expectedAuctionCloseTick, auctionSeatCount] = await Promise.all([
    Mining.fetchWinningBids(client),
    mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address),
    client.query.miningSlot.historicalBidsPerSlot().then(x => x[0]?.bidsCount ?? 0),
    mining.fetchTickAtStartOfAuctionClosing(client),
    client.query.miningSlot.nextCohortSize(),
  ]);

  return {
    frameId,
    totalBidCount,
    auctionSeatCount: auctionSeatCount ?? undefined,
    myLastBidMicrogons: bot.state?.lastBid?.microgonsPerSeat,
    winningBids,
    slots,
    expectedAuctionCloseTick,
  };
}

Vue.watch(() => myMiningSeats.frames, loadChartData, { deep: true });

Vue.watch(
  [() => myMiningSeats.latestFrameId, () => myMiningSeats.financialRevision, () => bot.isReady],
  () => {
    if (!myMiningSeats.latestFrameId) return;
    void refreshLiveFrameDetail();
  },
  { immediate: true },
);

async function refreshLiveFrameDetail() {
  const frameId = myMiningSeats.latestFrameId;
  const requestId = ++frameDetailRequestId;
  let hasFallbackDetail = false;

  if (liveAuctionCloseTick.value?.frameId !== frameId) {
    void refreshLiveAuctionCloseTick(frameId);
  }

  if (!bot.isReady && frameDetail.value?.frameId !== frameId) {
    void loadLiveFrameDetailFromChain(frameId)
      .then(detail => {
        if (requestId !== frameDetailRequestId || myMiningSeats.latestFrameId !== frameId) {
          return;
        }
        if (frameDetail.value?.frameId === frameId) return;

        hasFallbackDetail = true;
        frameDetail.value = detail;
      })
      .catch(error => {
        console.error(`[Mining Dashboard] Failed to load live frame fallback for frame ${frameId}`, error);
      });
  }

  try {
    const detail = await loadFrameDetail(frameId);
    if (requestId !== frameDetailRequestId || myMiningSeats.latestFrameId !== frameId) {
      return;
    }
    frameDetail.value = detail;
  } catch (error) {
    if (hasFallbackDetail) return;
    console.error(`[Mining Dashboard] Failed to refresh live frame detail for frame ${frameId}`, error);
  }
}

Vue.onMounted(() => {
  void myMiningSeats.subscribeToDashboard({ selectLatestFrame: true });
  void myMiningSeats.subscribeToActivity();
  loadChartData();

  void blockWatch
    .start()
    .then(() => {
      lastBlockMinerAddress.value = blockWatch.bestBlockHeader.author;
      stopBestBlockSubscription = blockWatch.events.on('best-blocks', blocks => {
        lastBlockMinerAddress.value = blocks.at(-1)?.author;
      });
    })
    .catch(error => {
      console.error('[Mining Dashboard] Failed to subscribe to best blocks', error);
    });

  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

Vue.onUnmounted(() => {
  myMiningSeats.unsubscribeFromDashboard();
  myMiningSeats.unsubscribeFromActivity();
  stopBestBlockSubscription?.();
  window.removeEventListener('focus', onWindowFocus);
  document.removeEventListener('visibilitychange', onVisibilityChange);
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
