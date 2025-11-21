<template>
  <ul class="text-md relative mb-4 flex min-h-6/12 w-full flex-col items-center whitespace-nowrap">
    <li class="flex min-h-[calc(100%/7)] w-full flex-col pt-2 pb-3">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <ArgonIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">Bidding Reserves</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningWallet.availableMicrogons).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <p class="break-words whitespace-normal">These argons are currently sitting unused.</p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(unusedMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicrogons"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(unusedMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicronots"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicronots).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <MiningBidIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">
            Winning
            <span class="hidden 2xl:inline">Mining</span>
            Bids ({{ numeral(stats.myMiningBids.bidCount).format('0,0') }})
          </div>
          <div class="pr-1">{{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}</div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <p class="break-words whitespace-normal">
            You have a total of {{ numeral(stats.myMiningBids.bidCount).format('0,0') }} winning bids in today's mining
            auction. They include both argons and argonots at a total value of {{ currency.symbol
            }}{{ microgonToMoneyNm(wallets.miningBidValue).format('0,0.00') }}:
          </p>
          <table class="my-3 w-full text-slate-800/50">
            <thead>
              <tr>
                <th class="h-10 w-1/4">Token</th>
                <th class="w-1/4 text-right">Per Seat</th>
                <th class="w-1/4 text-right">Total</th>
                <th class="h-10 w-1/4 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="h-10 border-t border-gray-600/20 pr-5">Argons</td>
                <td class="border-t border-gray-600/20 text-right">
                  {{
                    microgonToMoneyNm(wallets.miningBidMicrogons / BigInt(stats.myMiningBids.bidCount)).format('0,0.00')
                  }}
                </td>
                <td class="border-t border-gray-600/20 text-right">
                  {{ microgonToMoneyNm(wallets.miningBidMicrogons).format('0,0.00') }}
                </td>
                <td class="border-t border-gray-600/20 text-right">
                  {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningBidMicrogons).format('0,0.00') }}
                </td>
              </tr>
              <tr>
                <td class="h-10 border-y border-gray-600/20 pr-5">Argonots</td>
                <td class="border-y border-gray-600/20 text-right">
                  {{
                    microgonToMoneyNm(wallets.miningBidMicronots / BigInt(stats.myMiningBids.bidCount)).format('0,0.00')
                  }}
                </td>
                <td class="border-y border-gray-600/20 text-right">
                  {{ microgonToMoneyNm(wallets.miningBidMicronots).format('0,0.00') }}
                </td>
                <td class="border-y border-gray-600/20 text-right">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(currency.micronotToMicrogon(wallets.miningBidMicronots)).format('0,0.00') }}
                </td>
              </tr>
            </tbody>
          </table>

          <p class="break-words whitespace-normal">
            If any bids lose, all associated tokens will automatically revert back to your mining wallet.
          </p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(wallets.miningBidMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicrogons"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(wallets.miningBidMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicronots"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicronots).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li class="flex w-full flex-col border-t border-dashed border-gray-600/20 py-2">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <MiningSeatIcon class="text-argon-600/70 mr-2 h-7 w-7" />
          <div class="grow">
            Active
            <span class="hidden 2xl:inline">Mining</span>
            Seats ({{ numeral(stats.myMiningSeats.seatCount).format('0,0') }})
          </div>
          <div class="pr-1">{{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00') }}</div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <p class="break-words whitespace-normal">
            You have a total of {{ numeral(stats.myMiningSeats.seatCount).format('0,0') }} active mining seats. You won
            them using a combination of argons and argonots. They have an currently estimated value of
            {{ currency.symbol }}{{ microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00') }}.
          </p>
          <p class="mt-3 break-words whitespace-normal">
            These mining seats have
            {{ microgonToMoneyNm(stats.myMiningSeats.micronotsStakedTotal).format('0,0.00') }} argonots which will be
            released back into your wallet once the associated mining cycle completes.
          </p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
      <div class="ml-9 flex flex-col gap-y-1 text-slate-900/60">
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ microgonToArgonNm(wallets.miningSeatMicrogons).format('0,0.[00]') }} ARGN
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicrogons"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicrogons).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
        <HoverCardRoot :openDelay="200" :closeDelay="100">
          <HoverCardTrigger
            as="div"
            class="hover:text-argon-600 relative border-t border-dashed border-gray-600/20 pt-2">
            <ArrowTurnDownRightIcon
              class="absolute top-1/2 left-0 h-5 w-5 -translate-x-[130%] -translate-y-1/2 text-slate-600/40" />
            {{ micronotToArgonotNm(wallets.miningSeatMicronots).format('0,0.[00]') }} ARGNOT
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            :alignOffset="-20"
            side="right"
            :avoidCollisions="false"
            class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
            <p class="break-words whitespace-normal">
              These argonots are available for mining, but your bot hasn't found a competitively priced bid.
            </p>
            <div v-if="ruleUpdateError" class="my-2 font-semibold text-red-700">
              {{ ruleUpdateError }}
            </div>
            <div class="mt-3 flex w-full flex-row items-center border-t border-gray-600/20 pt-4">
              <button
                class="cursor-pointer rounded-md px-5 py-2 font-bold text-white"
                :class="[!isUpdatingRules ? 'bg-argon-600 hover:bg-argon-700' : 'bg-argon-600/60']"
                @click="sidelineMicronots"
                :disabled="isUpdatingRules">
                {{ !isUpdatingRules ? 'Sideline These' : 'Sidelining' }}
                {{ microgonToArgonNm(unusedMicronots).formatIfElse('< 100', '0,0.[00]', '0,0') }} Argons
              </button>
              <span :class="{ active: isUpdatingRules }" spinner class="mt-1 ml-2 inline-block" />
            </div>
            <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
          </HoverCardContent>
        </HoverCardRoot>
      </div>
    </li>
    <li class="flex w-full flex-row items-center border-t border-gray-600/40 py-2 text-red-900/70">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="flex w-full flex-row items-center hover:text-red-600">
          <div class="grow pl-1">
            <span class="hidden 2xl:inline">Operational</span>
            Expenses
          </div>
          <div class="pr-1">
            -{{ currency.symbol }}{{ microgonToMoneyNm(stats.global.transactionFeesTotal).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-md rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <p class="break-words whitespace-normal">
            The summation of all operational expenses that have been paid since you started mining.
          </p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </li>
    <li class="flex w-full flex-row items-center justify-between border-t border-b border-gray-600/40 py-2 font-bold">
      <HoverCardRoot :openDelay="200" :closeDelay="100">
        <HoverCardTrigger as="div" class="hover:text-argon-600 flex w-full flex-row items-center">
          <div class="grow pl-1">Total Value</div>
          <div class="pr-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(wallets.totalMiningResources).format('0,0.00') }}
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          :alignOffset="-20"
          side="right"
          :avoidCollisions="false"
          class="z-50 w-fit rounded-md border border-gray-800/20 bg-white p-4 text-slate-900/60 shadow-2xl">
          <p class="font-normal break-words whitespace-normal">The total value of your vault's assets.</p>
          <HoverCardArrow :width="27" :height="15" class="-mt-px fill-white stroke-gray-800/20 stroke-[0.5px]" />
        </HoverCardContent>
      </HoverCardRoot>
    </li>
  </ul>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { ArrowTurnDownRightIcon } from '@heroicons/vue/24/outline';
import ArgonIcon from '../assets/resources/argon.svg?component';
import ArgonotIcon from '../assets/resources/argonot.svg?component';
import MiningBidIcon from '../assets/resources/mining-bid.svg?component';
import MiningSeatIcon from '../assets/resources/mining-seat.svg?component';
import { useCurrency } from '../stores/currency.ts';
import { useWallets } from '../stores/wallets.ts';
import { useStats } from '../stores/stats.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral';
import { JsonExt } from '@argonprotocol/apps-core';
import { toRaw } from 'vue';
import { useConfig } from '../stores/config.ts';
import { useBot } from '../stores/bot.ts';

const currency = useCurrency();
const wallets = useWallets();
const config = useConfig();
const stats = useStats();
const bot = useBot();

const { microgonToMoneyNm, microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isUpdatingRules = Vue.ref(false);
const ruleUpdateError = Vue.ref('');

async function activateMicrogons() {
  const startRules = JsonExt.stringify(toRaw(config.biddingRules));
  config.biddingRules.sidelinedMicrogons -= sidelinedMicrogons.value;
  await saveUpdatedBiddingRules(startRules);
}

async function activateMicronots() {
  const startRules = JsonExt.stringify(toRaw(config.biddingRules));
  config.biddingRules.sidelinedMicronots -= sidelinedMicronots.value;
  await saveUpdatedBiddingRules(startRules);
}

async function sidelineMicronots() {
  const startRules = JsonExt.stringify(toRaw(config.biddingRules));
  config.biddingRules.sidelinedMicronots += unusedMicronots.value;
  await saveUpdatedBiddingRules(startRules);
}

async function sidelineMicrogons() {
  const startRules = JsonExt.stringify(toRaw(config.biddingRules));
  config.biddingRules.sidelinedMicrogons += unusedMicrogons.value;
  await saveUpdatedBiddingRules(startRules);
}

const sidelinedMicrogons = Vue.computed(() => {
  if (wallets.miningWallet.availableMicrogons >= config.biddingRules.sidelinedMicrogons) {
    return config.biddingRules.sidelinedMicrogons;
  }
  return 0n;
});

const sidelinedMicronots = Vue.computed(() => {
  if (wallets.miningWallet.availableMicronots >= config.biddingRules.sidelinedMicronots) {
    return config.biddingRules.sidelinedMicronots;
  }
  return 0n;
});

const unusedMicrogons = Vue.computed(() => {
  const unused = wallets.miningWallet.availableMicrogons - config.biddingRules.sidelinedMicrogons;
  return unused > 0n ? unused : 0n;
});

const unusedMicronots = Vue.computed(() => {
  const unused = wallets.miningWallet.availableMicronots - config.biddingRules.sidelinedMicronots;
  return unused > 0n ? unused : 0n;
});

async function saveUpdatedBiddingRules(startRules: string) {
  try {
    isUpdatingRules.value = true;
    await bot.resyncBiddingRules();
    config.saveBiddingRules();
  } catch (e) {
    ruleUpdateError.value = `Sorry, this allocation failed. Details: ${String(e)}`;
    config.biddingRules = JsonExt.parse(startRules);
  } finally {
    isUpdatingRules.value = false;
  }
}
</script>
