<template>
  <div class="flex h-full flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <template v-else>
      <!-- Blank state -->
      <div class="flex grow flex-col items-center justify-center">
        <div class="flex w-7/12 max-w-200 flex-col items-center pb-10">
          <div class="relative flex flex-row items-center justify-center gap-4">
            <div class="relative z-10 w-20 rounded-full bg-white shadow-md">
              <EthereumIcon class="text-argon-600/70 inline-block h-full w-full" />
            </div>
            <SwapIcon class="h-12 w-12 text-slate-400/80" />
            <div class="relative z-10 w-20 rounded-full bg-white shadow-md">
              <ArgonIcon class="text-argon-600/70 inline-block h-full w-full" />
            </div>
          </div>
          <p class="mt-10 w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
            Stable Swaps is a feature that monitors Argon's price on Uniswap and makes it easy to profit when the price
            deviates from target. Your stable swaps are ultimately backed by protocol’s Liquid Locking mechanism, which
            guarantees eventual restabilization. It does this by using Bitcoin shorts to drive the price back to target.
            This correction can take several days, which is where stable swaps come into play -- they profit from the
            short-term volatility.
          </p>
          <span class="relative">
            <button
              class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md px-12 py-2.5 text-base font-bold text-white">
              Activate Stable Swaps Feature
            </button>
            <CurvedArrow class="pointer-events-none absolute top-14 left-full h-22 translate-y-1 text-slate-400/80" />
          </span>
          <div class="relative mt-14 text-center">
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                class="h-24 w-80 rounded-full opacity-95 blur-lg"
                style="
                  background: radial-gradient(
                    ellipse at center,
                    #fffedc 0%,
                    #fffedc 42%,
                    rgba(255, 254, 220, 0.45) 62%,
                    rgba(255, 255, 255, 0) 78%
                  );
                " />
            </div>
            <div class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your
              <br />
              <span class="hover:text-argon-600/80 cursor-pointer underline">ethereum wallet</span>
              is funded.
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
  <!--  <div class="flex h-full flex-col gap-4 px-4 py-4">-->
  <!--    <header class="flex flex-row items-start justify-between gap-4">-->
  <!--      <div>-->
  <!--        <h2 class="text-xl font-bold text-slate-800/70">Stable Swaps</h2>-->
  <!--        <div class="mt-0.5 text-sm text-slate-400">-->
  <!--          Watch the live Argon discount on Uniswap, estimate the buy size needed to return to target, and track wallet-->
  <!--          swap performance.-->
  <!--        </div>-->
  <!--      </div>-->

  <!--      <button-->
  <!--        @click="stableSwaps.refreshMarket()"-->
  <!--        :disabled="stableSwaps.isLoadingMarket"-->
  <!--        class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50">-->
  <!--        Refresh Market-->
  <!--      </button>-->
  <!--    </header>-->

  <!--    <div-->
  <!--      v-if="!stableSwaps.marketSnapshot && stableSwaps.isLoadingMarket"-->
  <!--      class="flex grow items-center justify-center text-slate-500">-->
  <!--      Loading market snapshot...-->
  <!--    </div>-->

  <!--    <template v-else>-->
  <!--      <div-->
  <!--        v-if="stableSwaps.marketError"-->
  <!--        class="rounded-lg border border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-700">-->
  <!--        {{ stableSwaps.marketError }}-->
  <!--      </div>-->

  <!--      <div class="grid gap-4 xl:grid-cols-3">-->
  <!--        <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--          <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Current Price</div>-->
  <!--          <div class="mt-2 flex flex-row items-end gap-3">-->
  <!--            <div class="font-mono text-4xl font-bold text-slate-800">-->
  <!--              {{ currency.symbol }}{{ currentPriceDisplay }}-->
  <!--            </div>-->
  <!--            <div-->
  <!--              v-if="targetOffsetDisplay"-->
  <!--              :class="targetOffsetClasses"-->
  <!--              class="mb-1 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide">-->
  <!--              {{ targetOffsetDisplay }} off target-->
  <!--            </div>-->
  <!--          </div>-->
  <!--          <div class="mt-3 text-sm text-slate-500">-->
  <!--            <template v-if="targetPriceDisplay">-->
  <!--              Target:-->
  <!--              <span class="font-medium text-slate-700">{{ currency.symbol }}{{ targetPriceDisplay }}</span>-->
  <!--            </template>-->
  <!--            <template v-else>Waiting for the latest price index target from Argon.</template>-->
  <!--          </div>-->
  <!--        </section>-->

  <!--        <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--          <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Discounted Argons Available</div>-->
  <!--          <div class="mt-2 font-mono text-3xl font-bold text-slate-800">{{ discountedArgonsDisplay }} ARGN</div>-->
  <!--          <div class="mt-3 text-sm text-slate-500">-->
  <!--            <template v-if="costToTargetDisplay">-->
  <!--              Estimated spend:-->
  <!--              <span class="font-medium text-slate-700">{{ currency.symbol }}{{ costToTargetDisplay }}</span>-->
  <!--            </template>-->
  <!--            <template v-else>No discount is currently available in the live pool.</template>-->
  <!--          </div>-->
  <!--        </section>-->

  <!--        <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--          <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Return To Target</div>-->
  <!--          <div class="mt-2 font-mono text-3xl font-bold text-slate-800">-->
  <!--            {{ currency.symbol }}{{ projectedProfitDisplay }}-->
  <!--          </div>-->
  <!--          <div class="mt-3 text-sm text-slate-500">-->
  <!--            Gross mark-to-target profit if the discounted amount is bought and the price returns to the current peg.-->
  <!--          </div>-->
  <!--          <button-->
  <!--            @click="stableSwaps.openCurrentTrade()"-->
  <!--            :disabled="!stableSwaps.marketTradeUrl || !stableSwaps.marketSnapshot?.discountedEthereumArgonAmount"-->
  <!--            class="bg-argon-button hover:bg-argon-button-hover mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50">-->
  <!--            <ArrowTopRightOnSquareIcon class="h-4 w-4" />-->
  <!--            Buy Exact Argons On Uniswap-->
  <!--          </button>-->
  <!--        </section>-->
  <!--      </div>-->

  <!--      <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--        <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">-->
  <!--          <div>-->
  <!--            <div class="text-sm font-semibold text-slate-700">Wallet Tracker</div>-->
  <!--            <div class="mt-1 text-sm text-slate-400">-->
  <!--              Add a wallet to watch new Ethereum Argon buys from the current block onward.-->
  <!--            </div>-->
  <!--          </div>-->

  <!--          <form class="flex w-full max-w-3xl flex-col gap-2 sm:flex-row" @submit.prevent="submitWallet">-->
  <!--            <input-->
  <!--              v-model="walletInput"-->
  <!--              type="text"-->
  <!--              spellcheck="false"-->
  <!--              placeholder="0x..."-->
  <!--              class="focus:border-argon-500 focus:ring-argon-500/20 grow rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-700 transition outline-none focus:ring-2" />-->
  <!--            <button-->
  <!--              type="submit"-->
  <!--              :disabled="stableSwaps.isRefreshingWallet"-->
  <!--              class="rounded-md bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50">-->
  <!--              {{ stableSwaps.isRefreshingWallet ? 'Refreshing...' : 'Track Wallet' }}-->
  <!--            </button>-->
  <!--          </form>-->
  <!--        </div>-->

  <!--        <div-->
  <!--          v-if="stableSwaps.walletError"-->
  <!--          class="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">-->
  <!--          {{ stableSwaps.walletError }}-->
  <!--        </div>-->
  <!--        <div-->
  <!--          v-else-if="stableSwaps.walletMessage"-->
  <!--          class="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">-->
  <!--          {{ stableSwaps.walletMessage }}-->
  <!--        </div>-->
  <!--      </section>-->

  <!--      <template v-if="stableSwaps.walletSnapshot">-->
  <!--        <div class="grid gap-4 lg:grid-cols-4">-->
  <!--          <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--            <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Capital Applied</div>-->
  <!--            <div class="mt-2 font-mono text-2xl font-bold text-slate-800">-->
  <!--              {{ currency.symbol }}{{ capitalAppliedDisplay }}-->
  <!--            </div>-->
  <!--          </section>-->

  <!--          <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--            <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Current Profit</div>-->
  <!--            <div :class="walletProfitClasses" class="mt-2 font-mono text-2xl font-bold">-->
  <!--              {{ walletProfitDisplay }}-->
  <!--            </div>-->
  <!--          </section>-->

  <!--          <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--            <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Return</div>-->
  <!--            <div :class="walletProfitClasses" class="mt-2 font-mono text-2xl font-bold">-->
  <!--              {{ walletReturnDisplay }}-->
  <!--            </div>-->
  <!--          </section>-->

  <!--          <section class="rounded-lg border border-slate-300/50 bg-white px-6 py-5 shadow-sm">-->
  <!--            <div class="text-xs font-medium tracking-wide text-slate-400 uppercase">Tracked Purchases</div>-->
  <!--            <div class="mt-2 font-mono text-2xl font-bold text-slate-800">-->
  <!--              {{ stableSwaps.walletSnapshot.summary.purchaseCount }}-->
  <!--            </div>-->
  <!--            <div class="mt-2 text-sm text-slate-500">-->
  <!--              Watching from Ethereum block-->
  <!--              <span class="font-medium text-slate-700">-->
  <!--                {{ numeral(stableSwaps.walletSnapshot.summary.watchedSinceBlockNumber ?? 0).format('0,0') }}-->
  <!--              </span>-->
  <!--            </div>-->
  <!--          </section>-->
  <!--        </div>-->

  <!--        <section class="flex flex-col overflow-hidden rounded-lg border border-slate-300/50 bg-white shadow-sm">-->
  <!--          <div-->
  <!--            class="grid grid-cols-8 border-b border-slate-100 px-6 py-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">-->
  <!--            <div>Date</div>-->
  <!--            <div>Argons Bought</div>-->
  <!--            <div>Cost Basis</div>-->
  <!--            <div>Buy Price</div>-->
  <!--            <div>Oracle Price</div>-->
  <!--            <div>Uniswap Price</div>-->
  <!--            <div>Current P/L</div>-->
  <!--            <div class="text-right">Details</div>-->
  <!--          </div>-->

  <!--          <div-->
  <!--            v-if="stableSwaps.walletSnapshot.purchases.length === 0"-->
  <!--            class="px-6 py-10 text-center text-sm text-slate-500">-->
  <!--            No tracked purchases yet for this wallet.-->
  <!--          </div>-->

  <!--          <div v-else class="overflow-auto">-->
  <!--            <div-->
  <!--              v-for="purchase in stableSwaps.walletSnapshot.purchases"-->
  <!--              :key="purchase.txHash"-->
  <!--              class="grid grid-cols-8 items-center border-b border-slate-50 px-6 py-3 text-sm text-slate-700 last:border-0 hover:bg-slate-50/60">-->
  <!--              <div class="text-slate-500">{{ formatPurchaseDate(purchase.ethereumTimestamp) }}</div>-->
  <!--              <div class="font-mono">{{ formatEthereumArgonAmount(purchase.ethereumArgonAmount) }} ARGN</div>-->
  <!--              <div class="font-mono">{{ currency.symbol }}{{ formatMoneyMicrogons(purchase.costBasisMicrogons) }}</div>-->
  <!--              <div class="font-mono">-->
  <!--                {{ currency.symbol }}{{ formatMoneyMicrogons(purchase.effectiveBuyPriceMicrogons, '0,0.[0000]') }}-->
  <!--              </div>-->
  <!--              <div class="font-mono">-->
  <!--                {{ currency.symbol }}{{ formatOptionalMoneyMicrogons(purchase.argonOraclePriceMicrogons) }}-->
  <!--              </div>-->
  <!--              <div class="font-mono">-->
  <!--                {{ currency.symbol }}{{ formatMoneyMicrogons(purchase.uniswapPriceMicrogons, '0,0.[0000]') }}-->
  <!--              </div>-->
  <!--              <div-->
  <!--                :class="purchase.currentProfitMicrogons >= ZERO_BIGINT ? 'text-emerald-600' : 'text-rose-600'"-->
  <!--                class="font-mono font-semibold">-->
  <!--                {{ formatSignedMoneyMicrogons(purchase.currentProfitMicrogons) }}-->
  <!--              </div>-->
  <!--              <div class="text-right">-->
  <!--                <button-->
  <!--                  @click="openPurchaseTx(purchase.txHash)"-->
  <!--                  class="text-argon-600 hover:text-argon-700 inline-flex items-center gap-1 text-sm font-medium transition">-->
  <!--                  Tx-->
  <!--                  <ArrowTopRightOnSquareIcon class="h-3.5 w-3.5" />-->
  <!--                </button>-->
  <!--              </div>-->
  <!--            </div>-->
  <!--          </div>-->
  <!--        </section>-->
  <!--      </template>-->
  <!--    </template>-->
  <!--  </div>-->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import numeral from '../../lib/numeral.ts';
import { formatUnits } from 'viem';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import { getCurrency } from '../../stores/currency.ts';
import { useStableSwaps } from '../../stores/stableSwaps.ts';
import CurvedArrow from '../../components/CurvedArrow.vue';
import EthereumIcon from '../../assets/ethereum.svg';
import ArgonIcon from '../../assets/resources/argon.svg';
import SwapIcon from '../../assets/swap.svg';

const currency = getCurrency();
const stableSwaps = useStableSwaps();

const ZERO_BIGINT = BigInt(0);
const walletInput = Vue.ref('');
const isLoaded = Vue.ref(true);

const currentPriceDisplay = Vue.computed(() => {
  return stableSwaps.marketSnapshot
    ? formatMoneyMicrogons(stableSwaps.marketSnapshot.currentPriceMicrogons, '0,0.[0000]')
    : '0.0000';
});

const targetPriceDisplay = Vue.computed(() => {
  const target = stableSwaps.marketSnapshot?.targetPriceMicrogons;
  if (!target) {
    return '';
  }
  return formatMoneyMicrogons(target, '0,0.[0000]');
});

const targetOffsetDisplay = Vue.computed(() => {
  const snapshot = stableSwaps.marketSnapshot;
  if (!snapshot?.targetPriceMicrogons) {
    return '';
  }

  const offset = snapshot.currentPriceMicrogons - snapshot.targetPriceMicrogons;
  const prefix = offset >= ZERO_BIGINT ? '+' : '-';
  return `${prefix}${currency.symbol}${formatMoneyMicrogons(absBigInt(offset), '0,0.[0000]')}`;
});

const targetOffsetClasses = Vue.computed(() => {
  if (!stableSwaps.marketSnapshot?.targetPriceMicrogons) {
    return 'bg-slate-100 text-slate-500';
  }
  return stableSwaps.marketSnapshot.currentPriceMicrogons >= stableSwaps.marketSnapshot.targetPriceMicrogons
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-rose-50 text-rose-700';
});

const discountedArgonsDisplay = Vue.computed(() => {
  return formatEthereumArgonAmount(stableSwaps.marketSnapshot?.discountedEthereumArgonAmount ?? ZERO_BIGINT);
});

const costToTargetDisplay = Vue.computed(() => {
  const amount = stableSwaps.marketSnapshot?.costToTargetMicrogons ?? ZERO_BIGINT;
  if (amount <= ZERO_BIGINT) {
    return '';
  }
  return formatMoneyMicrogons(amount);
});

const projectedProfitDisplay = Vue.computed(() => {
  return formatMoneyMicrogons(stableSwaps.marketSnapshot?.projectedProfitMicrogons ?? ZERO_BIGINT);
});

const capitalAppliedDisplay = Vue.computed(() => {
  return formatMoneyMicrogons(stableSwaps.walletSnapshot?.summary.capitalAppliedMicrogons ?? ZERO_BIGINT);
});

const walletProfitClasses = Vue.computed(() => {
  return (stableSwaps.walletSnapshot?.summary.currentProfitMicrogons ?? ZERO_BIGINT) >= ZERO_BIGINT
    ? 'text-emerald-600'
    : 'text-rose-600';
});

const walletProfitDisplay = Vue.computed(() => {
  return formatSignedMoneyMicrogons(stableSwaps.walletSnapshot?.summary.currentProfitMicrogons ?? ZERO_BIGINT);
});

const walletReturnDisplay = Vue.computed(() => {
  const returnPct = stableSwaps.walletSnapshot?.summary.returnPct ?? 0;
  const prefix = returnPct >= 0 ? '+' : '';
  return `${prefix}${numeral(returnPct).format('0,0.[00]')}%`;
});

async function submitWallet() {
  await stableSwaps.lookupWallet(walletInput.value);
}

function formatPurchaseDate(date: Date) {
  return dayjs(date).format('MMM D, YYYY h:mm A');
}

function formatEthereumArgonAmount(amount: bigint) {
  return numeral(formatUnits(amount, 18)).format('0,0.[0000]');
}

function formatOptionalMoneyMicrogons(value?: bigint) {
  if (!value) {
    return '--';
  }
  return formatMoneyMicrogons(value, '0,0.[0000]');
}

function formatSignedMoneyMicrogons(value: bigint) {
  const prefix = value >= ZERO_BIGINT ? '+' : '-';
  return `${prefix}${currency.symbol}${formatMoneyMicrogons(absBigInt(value))}`;
}

function formatMoneyMicrogons(value: bigint, format = '0,0.00') {
  return numeral(currency.convertMicrogonTo(value, currency.key)).format(format);
}

async function openPurchaseTx(txHash: string) {
  await tauriOpenUrl(`https://etherscan.io/tx/${txHash}`);
}

function absBigInt(value: bigint) {
  return value >= ZERO_BIGINT ? value : -value;
}

Vue.watch(
  () => stableSwaps.selectedWalletAddress,
  value => {
    if (value) {
      walletInput.value = value;
    }
  },
  { immediate: true },
);

Vue.onMounted(async () => {
  await stableSwaps.load();
});
</script>
