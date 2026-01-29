<!-- prettier-ignore -->
<template>
  <PopoverRoot as="div" class="relative" @update:open="onOpen">
    <PopoverTrigger class="focus:outline-none">
      <slot>
        <span class="border border-argon-300 text-center text-lg font-bold mt-10 whitespace-nowrap text-argon-600 px-7 py-2 rounded cursor-pointer hover:bg-argon-50/40 hover:border-argon-600 transition-all duration-300">
          View Bidding Activity
        </span>
      </slot>
    </PopoverTrigger>
    <PopoverContent as="div" :class="panelPositioningClasses"
      class="absolute w-220 text-center text-lg font-bold mt-3 mr-4 bg-white rounded-lg shadow-lg border border-gray-300 z-50">
      <div :class="arrowPositioningClasses" class="absolute h-[15px] w-[30px] overflow-hidden">
        <div class="relative top-[5px] left-[5px] h-[20px] w-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
      </div>
      <div class="flex flex-col text-base px-6 pt-4 pb-2 h-full max-w-full">
        <h2 class="text-left text-2xl font-bold mb-2">Recent Bidding Activity</h2>
        <table class="w-full max-w-full grow font-mono text-md">
          <tbody class="font-light text-left">
            <tr v-for="activity of activities" :key="activity.id" class="whitespace-nowrap">
              <td class="text-left w-[5%]">
                <ActivityArrowIcon v-if="activity.type === 'bidUp'" class="w-5 h-5 text-green-500" />
                <ActivityArrowIcon v-if="activity.type === 'bidDown' && activity.isMine" class="w-5 h-5 rotate-180 text-red-500" />
                <ActivityArrowIcon v-if="activity.type === 'bidDown' && !activity.isMine" class="w-5 h-5 rotate-180 text-gray-200" />
                <ActivityArrowIcon v-if="activity.type === 'bidInc'" class="w-5 h-5 rotate-90 text-green-500" />
                <ActivityFailureIcon v-if="activity.type === 'failure'" class="w-5 h-5 text-red-500" />
                <ActivitySuccessIcon v-if="activity.type === 'success'" class="w-5 h-5 text-green-500" />
              </td>
              <td class="text-left opacity-50 pl-[30px] w-[10%]">
                {{ activity.timestamp.local().fromNow() }}
              </td>
              <template v-if="['bidUp', 'bidDown'].includes(activity.type)">
                <td class="pl-[30px] w-[30%] text-left">{{ activity.message }}</td>
                <td class="text-left relative pl-[30px] opacity-80 w-[55%]">
                  <div v-if="activity.bidderAddress">
                    <span class="opacity-60">{{ activity.bidderAddress.slice(0, 10) }}&nbsp;</span>
                    <span v-if="activity.isMine" class="absolute right-0 top-1/2 -translate-y-1/2 bg-argon-600 text-white px-1.5 pb-0.25 rounded text-sm">
                      YOU
                      <span class="absolute top-0 -left-3 inline-block h-full bg-gradient-to-r from-transparent to-white w-3"></span>
                    </span>
                  </div>
                </td>
              </template>
              <td v-else colspan="2" class="pl-[30px]">
                {{ activity.message }}
              </td>
            </tr>
            <tr v-for="i in 15 - activities.length" :key="i">
              <td class="text-left text-gray-300"><div class="w-full h-5 bg-gray-100" /></td>
              <td class="text-left text-gray-300 pr-2"><div class="w-full h-5 bg-gray-100" /></td>
              <td class="text-left text-gray-300 pr-2"><div class="w-full h-5 bg-gray-100" /></td>
              <td class="text-right text-gray-300"><div class="w-full h-5 bg-gray-100" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </PopoverContent>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../stores/currency';
import { PopoverContent, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { createNumeralHelpers } from '../lib/numeral';
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

dayjs.extend(utc);
dayjs.extend(relativeTime);

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'top';
  }>(),
  {
    position: 'top',
  },
);

const bot = getBot();
const isOpen = Vue.ref(false);
function onOpen(open: boolean) {
  console.log('BotHistoryOverlayButton onOpen', open);
  isOpen.value = open;
  if (open) {
    updateActivities();
  }
}

botEmitter.on('updated-server-state', async () => {
  if (!isOpen.value) return;
  await updateActivities();
});

async function updateActivities() {
  const client = await bot.getClient();
  const biddingActivity = await client.fetch('/history');
  biddingActivity.activities.sort((a, b) => b.id - a.id);
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
    activities.value.unshift({
      id,
      type,
      bidderAddress,
      isMine,
      timestamp: dayjs.utc(timestamp),
      message,
    });
  }
  if (activities.value.length > 15) {
    activities.value = activities.value.slice(0, 15);
  }
}

const walletKeys = getWalletKeys();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const panelPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[-140px] right-[calc(100%+10px)] h-160 ';
  } else {
    // props.position === 'top'
    return 'top-[-55px] left-1/2 -translate-x-1/2 -translate-y-full h-140';
  }
});

const arrowPositioningClasses = Vue.computed(() => {
  if (props.position === 'left') {
    return 'top-[122px] right-0 translate-x-[22.5px] -translate-y-full rotate-90';
  } else {
    // props.position === 'top'
    return 'top-full left-1/2 -translate-x-1/2 rotate-180';
  }
});

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
