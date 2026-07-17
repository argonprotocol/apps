<!-- prettier-ignore -->
<template>
  <PopoverRoot as="div" @update:open="onOpen">
    <PopoverTrigger type="button" class="inline-flex appearance-none bg-transparent p-0 text-left focus:outline-none">
      <slot>
        <span class="border border-argon-300 text-center text-lg font-bold mt-10 whitespace-nowrap text-argon-600 px-7 py-2 rounded cursor-pointer hover:bg-argon-50/40 hover:border-argon-600 transition-all duration-300">
          View Bidding Activity
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        as="div"
        :side="popoverSide"
        align="center"
        :sideOffset="10"
        :collisionPadding="24"
        :avoidCollisions="true"
        :style="floatingZIndex"
        class="group relative w-220 rounded-lg border border-gray-300 bg-white text-center text-lg font-bold shadow-lg"
      >
        <PopoverPanelArrow />
        <div class="flex h-full max-w-full flex-col px-6 pt-4 pb-2 text-base">
          <h2 class="mb-2 text-left text-2xl font-bold">Recent Bidding Activity</h2>
          <table class="text-md w-full max-w-full grow font-mono">
            <tbody class="text-left font-light">
              <tr v-for="activity of activities" :key="activity.id" class="whitespace-nowrap">
                <td class="w-[5%] text-left">
                  <ActivityArrowIcon v-if="activity.type === 'bidUp'" class="h-5 w-5 text-green-500" />
                  <ActivityArrowIcon v-if="activity.type === 'bidDown' && activity.isMine" class="h-5 w-5 rotate-180 text-red-500" />
                  <ActivityArrowIcon v-if="activity.type === 'bidDown' && !activity.isMine" class="h-5 w-5 rotate-180 text-gray-200" />
                  <ActivityArrowIcon v-if="activity.type === 'bidInc'" class="h-5 w-5 rotate-90 text-green-500" />
                  <ActivityFailureIcon v-if="activity.type === 'failure'" class="h-5 w-5 text-red-500" />
                  <ActivitySuccessIcon v-if="activity.type === 'success'" class="h-5 w-5 text-green-500" />
                </td>
                <td class="w-[10%] pl-[30px] text-left opacity-50">
                  {{ activity.timestamp.local().fromNow() }}
                </td>
                <template v-if="['bidUp', 'bidDown'].includes(activity.type)">
                  <td class="w-[30%] pl-[30px] text-left">{{ activity.message }}</td>
                  <td class="relative w-[55%] pl-[30px] text-left opacity-80">
                    <div v-if="activity.bidderAddress">
                      <span class="opacity-60">{{ activity.bidderAddress.slice(0, 10) }}&nbsp;</span>
                      <span v-if="activity.isMine" class="absolute top-1/2 right-0 -translate-y-1/2 rounded bg-argon-600 px-1.5 pb-0.25 text-sm text-white">
                        YOU
                        <span class="absolute top-0 -left-3 inline-block h-full w-3 bg-gradient-to-r from-transparent to-white"></span>
                      </span>
                    </div>
                  </td>
                </template>
                <td v-else colspan="2" class="pl-[30px]">
                  {{ activity.message }}
                </td>
              </tr>
              <tr v-for="i in 15 - activities.length" :key="i">
                <td class="text-left text-gray-300"><div class="h-5 w-full bg-gray-100" /></td>
                <td class="pr-2 text-left text-gray-300"><div class="h-5 w-full bg-gray-100" /></td>
                <td class="pr-2 text-left text-gray-300"><div class="h-5 w-full bg-gray-100" /></td>
                <td class="text-right text-gray-300"><div class="h-5 w-full bg-gray-100" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency.ts';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { createNumeralHelpers } from '../lib/numeral.ts';
import {
  BotActivityType,
  type IBotActivity,
  type IBotActivityBidReceived,
  type IBotActivityBidsRejected,
  type IBotActivityBidsSubmitted,
  type IBotActivitySeatReduction,
  MiningFrames,
} from '@argonprotocol/apps-core';
import ActivityArrowIcon from '../assets/activity-arrow.svg?component';
import ActivityFailureIcon from '../assets/activity-failure.svg?component';
import ActivitySuccessIcon from '../assets/activity-success.svg?component';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getWalletKeys } from '../stores/wallets.ts';
import { botEmitter } from '../lib/Bot.ts';
import { getBot } from '../stores/bot.ts';
import { getConfig } from '../stores/config.ts';
import PopoverPanelArrow from '../components/PopoverPanelArrow.vue';
import { useFloatingZIndex } from './helpers/OverlayZIndex.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'right' | 'top';
  }>(),
  {
    position: 'top',
  },
);

const bot = getBot();
const config = getConfig();
const isOpen = Vue.ref(false);
const floatingZIndex = useFloatingZIndex();

const popoverSide = Vue.computed(() => {
  if (props.position === 'left') {
    return 'left';
  }

  return props.position === 'right' ? 'right' : 'top';
});

function onOpen(open: boolean) {
  isOpen.value = open;
  if (open) {
    void updateActivities();
  }
}

async function onServerStateUpdated() {
  if (!isOpen.value) return;
  await updateActivities();
}
Vue.onMounted(() => {
  botEmitter.on('updated-server-state', onServerStateUpdated);
});
Vue.onUnmounted(() => {
  botEmitter.off('updated-server-state', onServerStateUpdated);
});

async function updateActivities() {
  if (!config.isServerInstalled) {
    activities.value = [];
    return;
  }
  const client = await bot.getClient();
  const biddingActivity = await client.fetch('/history');
  for (const activity of biddingActivity.activities) {
    if (activities.value.find(a => a.id === activity.id)) {
      continue;
    }
    const id = activity.id;
    const type = extractBidType(activity);
    let bidderAddress: string | undefined = undefined;
    let isMine = false;
    if (activity.type === BotActivityType.BidReceived) {
      bidderAddress = activity.data.bidderAddress;
      isMine = subaccounts.value.has(bidderAddress);
    }
    const timestamp = MiningFrames.getTickDate(activity.tick);
    const message = extractMessage(activity);
    activities.value.push({
      id,
      type,
      bidderAddress,
      isMine,
      timestamp: dayjs.utc(timestamp),
      message,
    });
  }

  activities.value.sort((a, b) => b.id - a.id);
  if (activities.value.length > 15) {
    activities.value = activities.value.slice(0, 15);
  }
}

const walletKeys = getWalletKeys();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const subaccounts = Vue.ref(new Set<string>());
Vue.onMounted(() => {
  walletKeys.getMiningBotSubaccounts().then(x => {
    for (const key of Object.keys(x)) {
      subaccounts.value.add(key);
    }
  });
});

const activities = Vue.ref(
  [] as {
    id: number;
    type: string;
    bidderAddress: string | undefined;
    isMine: boolean;
    timestamp: dayjs.Dayjs;
    message: string;
  }[],
);

function extractMessage(activity: IBotActivity): string {
  if (activity.type === BotActivityType.BidReceived) {
    const {
      bidPosition,
      previousBidPosition,
      microgonsPerSeat: microgonsBid,
      previousMicrogonsPerSeat: previousMicrogonsBid,
    } = activity.data as IBotActivityBidReceived;
    if (previousBidPosition === undefined || previousBidPosition === null) {
      return `A new bid of ${currency.symbol}${microgonToMoneyNm(microgonsBid).format('0,0.00')} was inserted at position #${(bidPosition || 0) + 1}`;
    } else {
      let action = 'fell off the list';
      if (bidPosition !== null && bidPosition !== undefined) {
        if (bidPosition < previousBidPosition) {
          action = `rose to position #${bidPosition + 1}`;
        } else if (bidPosition === previousBidPosition) {
          action = `added ${currency.symbol}${microgonToMoneyNm((microgonsBid ?? 0n) - (previousMicrogonsBid ?? 0n)).format('0,0.00')} at position #${bidPosition + 1}`;
        } else {
          action = `fell to position #${bidPosition + 1}`;
        }
      }
      return `Existing bid #${previousBidPosition + 1} (${currency.symbol}${microgonToMoneyNm(microgonsBid ?? 0n).format('0,0.00')}) ${action}`;
    }
  } else if (activity.type === BotActivityType.BidsSubmitted) {
    const { microgonsPerSeat, submittedCount } = activity.data as IBotActivityBidsSubmitted;
    return `${submittedCount} new bids were submitted for ${currency.symbol}${microgonToMoneyNm(microgonsPerSeat).format('0,0.00')} per seat`;
  } else if (activity.type === BotActivityType.SeatReduction) {
    const { prevSeatsInPlay, maxSeatsInPlay } = activity.data as IBotActivitySeatReduction;
    return `The number of seats you can win dropped from ${prevSeatsInPlay} to ${maxSeatsInPlay}`;
  } else if (activity.type === BotActivityType.BidsRejected) {
    const { rejectedCount, microgonsPerSeat } = activity.data as IBotActivityBidsRejected;
    return `${rejectedCount} incoming bids were rejected for ${currency.symbol}${microgonToMoneyNm(microgonsPerSeat).format('0,0.00')} per seat`;
  }

  return activity.type;
}

function extractBidType(activity: IBotActivity): 'bidUp' | 'bidDown' | 'bidInc' | 'failure' | 'success' | 'unknown' {
  const successTypes = [
    BotActivityType.Starting,
    BotActivityType.DockersConfirmed,
    BotActivityType.StartedSyncing,
    BotActivityType.FinishedSyncing,
    BotActivityType.Ready,
    BotActivityType.AuctionStarted,
    BotActivityType.AuctionFinished,
    BotActivityType.BidsSubmitted,
    BotActivityType.SeatExpansion,
  ];
  const failureTypes = [
    BotActivityType.Shutdown,
    BotActivityType.Error,
    BotActivityType.BidsRejected,
    BotActivityType.SeatReduction,
  ];

  if (successTypes.includes(activity.type)) {
    return 'success';
  } else if (failureTypes.includes(activity.type)) {
    return 'failure';
  }

  if (activity.type === BotActivityType.BidReceived) {
    if (activity.data.bidPosition === undefined || activity.data.bidPosition === null) {
      return 'bidDown';
    } else if (activity.data.previousBidPosition === undefined || activity.data.previousBidPosition === null) {
      return 'bidUp';
    } else if (activity.data.bidPosition < activity.data.previousBidPosition) {
      return 'bidUp';
    } else if (activity.data.bidPosition === activity.data.previousBidPosition) {
      return 'bidInc';
    } else {
      return 'bidDown';
    }
  }

  return 'unknown';
}
</script>

<style scoped>
@reference "../main.css";

table td {
  @apply border-t border-gray-300 py-0.5;
}
</style>
