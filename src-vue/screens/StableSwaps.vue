<template>
  <div DashBox class="flex h-full flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <!-- Blank state -->
    <div v-else-if="!config.hasActivatedStableSwaps" class="flex grow flex-col">
      <div class="flex grow flex-col items-center justify-center">
        <div class="flex w-8/12 max-w-200 flex-col items-center pt-10 pb-5">
          <header class="text-argon-600 pb-3 text-xl font-bold">Argon Is a Multi-Chain, Global Currency</header>
          <p class="w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
            Stable Swaps is a feature that monitors Argon's price on Uniswap, making it easy to profit when the price
            deviates from target. Your swaps are backed by protocol’s Liquid Locking mechanism, which guarantees
            eventual restabilization. It does this by using Bitcoin shorts to drive the price back to target. This
            correction can take several days, which is where stable swaps come into play -- they profit from the
            short-term opportunities.
          </p>
          <span class="relative">
            <button
              @click="activateStableSwaps"
              :class="
                financials.swapsTotalValue
                  ? 'bg-argon-button hover:bg-argon-button-hover border-transparent text-white'
                  : 'pointer-events-none border-gray-500 bg-white text-gray-500 opacity-40'
              "
              class="mt-12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold"
            >
              Activate Stable Swaps
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
                "
              />
            </div>
            <div v-if="financials.swapsTotalValue" class="text-argon-600 relative text-xl leading-8 font-bold">
              Your account has {{ currency.symbol
              }}{{ microgonToMoneyNm(financials.swapsTotalValue).format('0,0.00') }} on ethereum that
              <br />
              is ready for immediate deployment.
            </div>
            <div v-else class="text-argon-600 relative text-xl leading-8 font-bold">
              This feature is disabled until your
              <br />
              <span @click="openEthereumWallet" class="hover:text-argon-600/80 cursor-pointer underline">
                ethereum wallet
              </span>
              is funded.
            </div>
          </div>
        </div>
      </div>
      <div class="relative px-0.5 pb-0.5">
        <img src="/treasury-footers/stable-swaps.png" class="w-full opacity-50" />
      </div>
    </div>

    <div v-else class="flex h-full flex-col pt-4">
      <section class="mx-9 mt-5 flex flex-row items-end gap-x-2 text-center">
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-argon-600 inline-flex text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :value="financials.swapsTotalValue" />
          </div>
          <div>Total Swap Assets</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-argon-600 flex flex-row items-center justify-center gap-x-2 text-5xl font-bold">
            <span>2</span>
            <div class="flex flex-row text-[#BE93CB]">
              <div class="rounded-xl bg-white p-[1.5px]" style="box-shadow: 0 0 5px 1px rgba(0, 0, 0, 0.1)">
                <div class="flex h-9 w-9 flex-row items-center justify-center rounded-xl border-1 border-[#D4B6DD]">
                  <ArgonIcon class="size-6" />
                </div>
              </div>
              <div
                class="relative -left-[25%] rounded-xl bg-white p-[1.5px]"
                style="box-shadow: 0 0 5px 1px rgba(0, 0, 0, 0.1)"
              >
                <div class="flex h-9 w-9 flex-row items-center justify-center rounded-xl border-1 border-[#D4B6DD]">
                  <EthereumIcon class="size-6" />
                </div>
              </div>
            </div>
          </div>
          <!--          Watching from Ethereum block-->
          <!--          <span class="font-medium text-slate-700">-->
          <!--            {{ numeral(stableSwaps.walletSnapshot?.summary.watchedSinceBlockNumber ?? 0).format('0,0') }}-->
          <!--          </span>-->
          <div>Active Networks</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-argon-600 text-5xl font-bold">{{ numeral(totalSwapReturn).format('0,0.[00]') }}%</div>
          <div>Total Swap Profits</div>
        </div>
      </section>

      <div class="relative flex min-h-0 grow flex-col">
        <div class="flex grow flex-col overflow-y-auto pt-10">
          <div class="flex flex-row items-center px-9 text-slate-800/70">
            <span class="grow">
              You have {{ stableSwaps.swaps.length }} swap opportunit{{
                stableSwaps.swaps.length === 1 ? 'y' : 'ies'
              }}...
            </span>
            <div class="flex flex-row items-stretch gap-x-3">
              <button class="text-md text-argon-600 cursor-pointer">Refresh List</button>
              <div class="w-px bg-slate-400/50" />
              <a href="https://argon.network/" target="_blank" class="text-md text-argon-600 cursor-pointer">
                View Docs
              </a>
            </div>
          </div>

          <div class="mt-4 flex grow flex-col">
            <section
              v-if="stableSwaps.marketError"
              class="mx-9 flex min-h-20 flex-col items-center rounded border border-rose-300/50 bg-rose-50/60 px-6 py-12 text-center text-rose-700"
            >
              <p class="font-medium">Stable swaps could not load.</p>
              <p class="mt-2 text-sm text-rose-700/80">{{ stableSwaps.marketError }}</p>
            </section>

            <section v-if="stableSwaps.swaps.length" class="mx-9 flex flex-col gap-y-2 pb-10">
              <SwapRecord v-for="swap of stableSwaps.swaps" :swap="swap" />
            </section>

            <section
              v-else-if="!stableSwaps.marketError"
              class="mx-9 flex min-h-20 flex-col items-center rounded border border-slate-400/20 bg-slate-400/5 px-6 py-16 text-center text-slate-600/60"
            >
              <p>
                Argon is on target, which means there are
                <br />
                no swap opportunities currently available.
              </p>
              <div
                :class="currencyFadeClass"
                class="mt-5 flex flex-row items-center border-y border-slate-600/10 py-2 pr-2 pl-1 transition-opacity duration-400 ease-in-out"
              >
                <CheckIcon class="mr-2 size-5" />
                <span>
                  ARGN is trading on Ethereum at {{ currencySymbol
                  }}{{ microgonToNm(oneArgonInMicrogons, currencyKey).format('0.00[0]') }}
                </span>
              </div>
            </section>

            <section v-if="stableSwaps.walletSnapshot?.purchases.length" class="mx-9 mt-10 flex grow flex-col">
              <div
                class="grid grid-cols-8 border-b border-slate-100 px-6 py-3 text-xs font-semibold tracking-wide text-slate-400 uppercase"
              >
                <div>Date</div>
                <div>Argons Bought</div>
                <div>Cost Basis</div>
                <div>Buy Price</div>
                <div>Oracle Price</div>
                <div>Uniswap Price</div>
                <div>Current P/L</div>
                <div class="text-right">Details</div>
              </div>

              <div class="overflow-auto">
                <div
                  v-for="purchase in stableSwaps.walletSnapshot?.purchases"
                  :key="purchase.txHash"
                  class="grid grid-cols-8 items-center border-b border-slate-50 px-6 py-3 text-sm text-slate-700 last:border-0 hover:bg-slate-50/60"
                >
                  <div class="text-slate-500">{{ dayjs(purchase.ethereumTimestamp).format('MMM D, YYYY h:mm A') }}</div>
                  <div class="font-mono">
                    {{ numeral(formatUnits(purchase.ethereumArgonAmount, 18)).format('0,0.[0000]') }} ARGN
                  </div>
                  <div class="font-mono">
                    {{ currency.symbol }}{{ microgonToMoneyNm(purchase.costBasisMicrogons).format('0,0.00') }}
                  </div>
                  <div class="font-mono">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(purchase.effectiveBuyPriceMicrogons).format('0,0.[0000]') }}
                  </div>
                  <div class="font-mono">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(purchase.argonOraclePriceMicrogons || zeroMicrogons).format('0,0.[0000]') }}
                  </div>
                  <div class="font-mono">
                    {{ currency.symbol }}{{ microgonToMoneyNm(purchase.uniswapPriceMicrogons).format('0,0.[0000]') }}
                  </div>
                  <div
                    :class="purchase.currentProfitMicrogons >= zeroMicrogons ? 'text-emerald-600' : 'text-rose-600'"
                    class="font-mono font-semibold"
                  >
                    {{ purchase.currentProfitMicrogons >= zeroMicrogons ? '+' : '-' }}{{ currency.symbol
                    }}{{ microgonToMoneyNm(purchase.currentProfitMicrogons).format('0,0.00') }}
                  </div>
                  <div class="text-right">
                    <button
                      @click="openPurchaseTx(purchase.txHash)"
                      class="text-argon-600 hover:text-argon-700 inline-flex items-center gap-1 text-sm font-medium transition"
                    >
                      Tx
                      <ArrowTopRightOnSquareIcon class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
          <div class="relative px-0.5 pb-0.5">
            <img src="/treasury-footers/stable-swaps.png" class="w-full opacity-50" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { formatUnits } from 'viem';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { getCurrency } from '../stores/currency.ts';
import { useStableSwaps } from '../stores/stableSwaps.ts';
import CurvedArrow from '../components/CurvedArrow.vue';
import EthereumIcon from '../assets/networks/ethereum.svg';
import ArgonIcon from '../assets/networks/argon.svg';
import SwapIcon from '../assets/swap.svg';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';
import { bigIntAbs, ICurrencyKey, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getConfig } from '../stores/config.ts';
import { ArrowTopRightOnSquareIcon, CheckIcon } from '@heroicons/vue/24/outline';
import Arrow from '../components/Arrow.vue';
import FormattedMoney from '../components/FormattedMoney.vue';
import { useFinancials } from '../stores/financials.ts';
import SwapRecord from './treasury-screens/components/SwapRecord.vue';

const currency = getCurrency();
const financials = useFinancials();
const stableSwaps = useStableSwaps();
const config = getConfig();

const { microgonToMoneyNm, microgonToNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);

const currencyKey = Vue.ref<ICurrencyKey>(UnitOfMeasurement.USD);
const oneArgonInMicrogons = 1000000n;
const zeroMicrogons = 0n;

const currencySymbol = Vue.computed(() => {
  return currency.recordsByKey[currencyKey.value].symbol;
});

const totalSwapReturn = Vue.computed(() => {
  return stableSwaps.walletSnapshot?.summary.returnPct ?? 0;
});

async function openPurchaseTx(txHash: string) {
  await tauriOpenUrl(`https://etherscan.io/tx/${txHash}`);
}

function openEthereumWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.ethereum });
}

async function activateStableSwaps() {
  config.hasActivatedStableSwaps = true;
  await config.save();
}

const currencyFadeClass = Vue.ref('');
const currencyPositions: ICurrencyKey[] = [
  UnitOfMeasurement.USD,
  UnitOfMeasurement.EUR,
  UnitOfMeasurement.GBP,
  UnitOfMeasurement.INR,
];

let currencyRotationInterval: ReturnType<typeof setTimeout> | undefined;
let setCurrencyKeyTimeout: ReturnType<typeof setTimeout> | undefined;

function startSetCurrencyKey(key: ICurrencyKey, shouldClearRotation: boolean = true) {
  if (!currency.isLoaded) return;
  if (setCurrencyKeyTimeout) clearTimeout(setCurrencyKeyTimeout);
  if (shouldClearRotation) clearInterval(currencyRotationInterval);

  currencyFadeClass.value = 'opacity-10';
  setCurrencyKeyTimeout = setTimeout(() => {
    finishSetCurrencyKey(key);
    currencyFadeClass.value = 'opacity-100';
  }, 400);
}

function finishSetCurrencyKey(key: ICurrencyKey) {
  currencyKey.value = key;
}

Vue.onMounted(async () => {
  try {
    await stableSwaps.load();
  } catch {
    // The store exposes the underlying marketError for this screen.
  }

  finishSetCurrencyKey(currencyKey.value);
  currencyRotationInterval = setInterval(() => {
    const currentIndex = currencyPositions.indexOf(currencyKey.value);
    const isLastIndex = currentIndex >= 3;
    const nextIndex = isLastIndex ? 0 : currentIndex + 1;
    const nextKey = currencyPositions[nextIndex];
    startSetCurrencyKey(nextKey, false);
    if (isLastIndex) {
      clearInterval(currencyRotationInterval);
    }
  }, 5e3);
  isLoaded.value = true;
});

Vue.onUnmounted(() => {
  clearInterval(currencyRotationInterval);
});
</script>
