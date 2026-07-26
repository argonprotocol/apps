<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-8/12 max-w-200 flex-col items-center pt-10 pb-5">
        <header class="text-argon-600 pb-3 text-xl font-bold">Argon Is a Multi-Chain, Global Currency</header>
        <p class="w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
          Stable Swaps is a feature that monitors Argon's price on Uniswap, making it easy to profit when the price
          deviates from target. Your swaps are backed by protocol’s Liquid Locking mechanism, which guarantees eventual
          restabilization. It does this by using Bitcoin shorts to drive the price back to target. This correction can
          take several days, which is where stable swaps come into play -- they profit from the short-term
          opportunities.
        </p>
        <span class="relative">
          <button
            data-curved-arrow-end
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
        </span>
        <div data-curved-arrow-start class="text-argon-600 relative mt-14 text-center text-xl leading-8 font-bold">
          <CurvedArrowRadialGradient />
          <div class="relative">
            <template v-if="financials.swapsTotalValue">
              Your account has {{ currency.symbol
              }}{{ microgonToMoneyNm(financials.swapsTotalValue).formatIfElse('< 1000', '0,0.00', '0,0') }} on ethereum
              that
              <br />
              is ready for immediate deployment.
            </template>
            <template v-else>
              This feature is disabled until your
              <br />
              <span @click="openEthereumWallet" class="hover:text-argon-600/80 cursor-pointer underline">
                ethereum wallet
              </span>
              is funded.
            </template>
          </div>
        </div>
        <CurvedArrow
          dynamic
          class="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-slate-400/80"
          :class="financials.swapsTotalValue ? 'opacity-100' : 'opacity-40'"
        />
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/stable-swaps.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { formatUnits } from 'viem';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { getCurrency } from '../../stores/currency.ts';
import { useStableSwaps } from '../../stores/stableSwaps.ts';
import CurvedArrow from '../../components/CurvedArrow.vue';
import EthereumIcon from '../../assets/networks/ethereum.svg';
import ArgonIcon from '../../assets/networks/argon.svg';
import SwapIcon from '../../assets/swap.svg';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { bigIntAbs, ICurrencyKey, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getConfig } from '../../stores/config.ts';
import { ArrowTopRightOnSquareIcon, CheckIcon } from '@heroicons/vue/24/outline';
import Arrow from '../../components/Arrow.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { useFinancials } from '../../stores/financials.ts';
import SwapRecord from '../treasury-screens/components/SwapRecord.vue';
import CurvedArrowRadialGradient from '../../components/CurvedArrowRadialGradient.vue';

const currency = getCurrency();
const financials = useFinancials();
const stableSwaps = useStableSwaps();
const config = getConfig();

const { microgonToMoneyNm, microgonToNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);

const currencyKey = Vue.ref<ICurrencyKey>(UnitOfMeasurement.USD);
const currencySymbol = Vue.computed(() => currency.recordsByKey[currencyKey.value].symbol);
const oneArgonInMicrogons = 1000000n;
const zeroMicrogons = 0n;

const totalSwapReturn = Vue.computed(() => {
  return financials.stableSwapPerformanceReturn;
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
  if (config.hasActivatedStableSwaps) {
    try {
      await stableSwaps.load();
    } catch {
      // The store exposes the underlying marketError for this screen.
    }
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
