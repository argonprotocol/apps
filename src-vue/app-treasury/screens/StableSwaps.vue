<template>
  <div class="flex h-full flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <div v-else-if="config.hasActivatedStableSwaps" class="flex h-full flex-col gap-4 px-6 py-4">
      <section class="mt-5 flex flex-row items-end gap-x-2 text-center">
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-5xl font-bold">
            {{ currency.symbol }}{{ microgonToMoneyNm(belowTargetAssets).format('0,0.00') }}
          </div>
          <div>Assets Targeting Below Target</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-6xl font-bold">{{ walletReturnDisplay }}</div>
          <div>Swap Profits</div>
        </div>
        <div class="h-full w-px bg-slate-400/30" />
        <div class="w-1/3 border-b border-slate-400/30 pb-5">
          <div class="text-5xl font-bold">
            {{ currency.symbol }}{{ microgonToMoneyNm(aboveTargetAssets).format('0,0.00') }}
          </div>
          <div>Assets Targeting Above Target</div>
        </div>
      </section>

      <section class="relative mt-24 mb-20 flex h-9 flex-row items-center">
        <div class="relative h-1 w-full bg-slate-500/40" />
        <div class="absolute top-full left-0 text-slate-500/60">{{ currency.symbol }}0.03</div>
        <div class="absolute top-full right-0 text-slate-500/60">{{ currency.symbol }}2.03</div>
        <div class="absolute top-full left-1/2 -translate-x-1/2 text-center text-slate-500/60">
          {{ currency.symbol }}{{ targetPriceDisplay }}
          <br />
          Target Price
        </div>
        <div
          class="bg-argon-600 absolute top-1/2 left-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white"
        />
        <div
          v-for="n in 4"
          :key="n"
          :style="{ left: `${Number(n) * 10}%` }"
          class="absolute top-1/2 mx-px h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-500/40"
        />
        <div
          v-for="n in 4"
          :key="n"
          :style="{ left: `${(Number(n) + 5) * 10}%` }"
          class="absolute top-1/2 mx-px h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-500/40"
        />
        <div class="absolute top-1/2 left-0 h-full w-px -translate-y-1/2 bg-slate-500/40" />
        <div class="absolute top-1/2 left-1/2 h-full w-1 -translate-x-1/2 -translate-y-1/2 bg-slate-500/50" />
        <div class="absolute top-1/2 right-0 h-full w-px -translate-y-1/2 bg-slate-500/50" />
        <div
          class="text-md absolute top-1/2 left-1/4 -translate-x-1/2 -translate-y-1/2 bg-white px-1 leading-5 text-slate-500/50"
        >
          BELOW TARGET
        </div>
        <div
          class="text-md absolute top-1/2 left-3/4 -translate-x-1/2 -translate-y-1/2 bg-white px-1 leading-5 text-slate-500/50"
        >
          ABOVE TARGET
        </div>
        <div
          class="absolute bottom-full left-1/2 -translate-x-1/2 rounded border border-slate-500/20 bg-white px-3 py-2 text-center shadow"
        >
          <strong>Exactly At Target</strong>
          <br />
          {{ currency.symbol }}{{ currentPriceDisplay }}
          <div class="absolute bottom-0 left-1/2 h-4 w-8 -translate-x-1/2 translate-y-full overflow-hidden">
            <Arrow :shadow="true" class="relative -top-px h-full w-full rotate-180" />
          </div>
        </div>
      </section>

      <section v-if="projectedProfitDisplay">
        Argons to Buy: {{ discountedArgonsDisplay }} ARGN Current Price: {{ currency.symbol
        }}{{ currentPriceDisplay }} Expected Profit: {{ currency.symbol }}{{ projectedProfitDisplay }} Estimated spend:
        <span class="font-medium text-slate-700">{{ currency.symbol }}{{ costToTargetDisplay }}</span>
        Offset from Target: {{ targetOffsetDisplay }}
        <button
          @click="stableSwaps.openCurrentTrade()"
          :disabled="!stableSwaps.marketTradeUrl || !stableSwaps.marketSnapshot?.discountedEthereumArgonAmount"
          class="bg-argon-button hover:bg-argon-button-hover mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowTopRightOnSquareIcon class="h-4 w-4" />
          Buy Exact Argons On Uniswap
        </button>
      </section>
      <section
        v-else
        class="min-h-20 rounded-lg border-2 border-dashed border-slate-400/50 px-6 py-16 text-center text-xl font-bold text-slate-500/40"
      >
        <div v-if="!stableSwaps.marketSnapshot && stableSwaps.isLoadingMarket">Loading...</div>
        <div v-else-if="stableSwaps.marketError">
          {{ stableSwaps.marketError }}
        </div>
        <div v-else>
          Price Is At Target
          <br />
          No Swap Opportunities
        </div>
      </section>

      <section class="flex flex-col overflow-hidden rounded-lg border border-slate-300/50 bg-white shadow-sm">
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

        <div
          v-if="stableSwaps.walletSnapshot?.purchases.length === 0"
          class="px-6 py-10 text-center text-sm text-slate-500"
        >
          No tracked purchases yet for this wallet.
        </div>

        <div v-else class="overflow-auto">
          <div
            v-for="purchase in stableSwaps.walletSnapshot?.purchases"
            :key="purchase.txHash"
            class="grid grid-cols-8 items-center border-b border-slate-50 px-6 py-3 text-sm text-slate-700 last:border-0 hover:bg-slate-50/60"
          >
            <div class="text-slate-500">{{ formatPurchaseDate(purchase.ethereumTimestamp) }}</div>
            <div class="font-mono">{{ formatEthereumArgonAmount(purchase.ethereumArgonAmount) }} ARGN</div>
            <div class="font-mono">{{ currency.symbol }}{{ formatMoneyMicrogons(purchase.costBasisMicrogons) }}</div>
            <div class="font-mono">
              {{ currency.symbol }}{{ formatMoneyMicrogons(purchase.effectiveBuyPriceMicrogons, '0,0.[0000]') }}
            </div>
            <div class="font-mono">
              {{ currency.symbol }}{{ formatOptionalMoneyMicrogons(purchase.argonOraclePriceMicrogons) }}
            </div>
            <div class="font-mono">
              {{ currency.symbol }}{{ formatMoneyMicrogons(purchase.uniswapPriceMicrogons, '0,0.[0000]') }}
            </div>
            <div
              :class="purchase.currentProfitMicrogons >= ZERO_BIGINT ? 'text-emerald-600' : 'text-rose-600'"
              class="font-mono font-semibold"
            >
              {{ formatSignedMoneyMicrogons(purchase.currentProfitMicrogons) }}
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

      Watching from Ethereum block
      <span class="font-medium text-slate-700">
        {{ numeral(stableSwaps.walletSnapshot?.summary.watchedSinceBlockNumber ?? 0).format('0,0') }}
      </span>
    </div>

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
            Stable Swaps is a feature that monitors Argon's price on Uniswap, making it easy to profit when the price
            deviates from target. Your stable swaps are ultimately backed by protocol’s Liquid Locking mechanism, which
            guarantees eventual restabilization. It does this by using Bitcoin shorts to drive the price back to target.
            This correction can take several days, which is where stable swaps come into play -- they profit from the
            short-term opportunities.
          </p>
          <span class="relative">
            <button
              @click="activateStableSwaps"
              :class="walletBalance ? '' : 'pointer-events-none bg-slate-600 opacity-40'"
              class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md px-12 py-2.5 text-base font-bold text-white"
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
            <div v-if="walletBalance" class="text-argon-600 relative text-xl leading-8 font-bold">
              Your account has {{ currency.symbol }}{{ microgonToMoneyNm(walletBalance).format('0,0.00') }} on ethereum
              that
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
    </template>
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
import EthereumIcon from '../../assets/ethereum.svg';
import ArgonIcon from '../../assets/resources/argon.svg';
import SwapIcon from '../../assets/swap.svg';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { type IOtherToken, WalletType } from '../../lib/Wallet.ts';
import { bigIntAbs, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useWallets } from '../../stores/wallets.ts';
import { getConfig } from '../../stores/config.ts';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import Arrow from '../../components/Arrow.vue';

const currency = getCurrency();
const stableSwaps = useStableSwaps();
const wallets = useWallets();
const config = getConfig();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const ZERO_BIGINT = BigInt(0);
const isLoaded = Vue.ref(true);

const belowTargetAssets = Vue.computed(() => {
  return wallets.ethereumWallet.otherTokens.reduce((totalValue, token) => {
    return totalValue + currency.convertOtherToMicrogon(token as IOtherToken);
  }, 0n);
});

const aboveTargetAssets = Vue.computed(() => {
  return 0n;
});

const walletBalance = Vue.computed(() => {
  const microgonValue = wallets.ethereumWallet.availableMicrogons;
  const micronotValue = currency.convertMicronotTo(
    wallets.ethereumWallet.availableMicronots,
    UnitOfMeasurement.Microgon,
  );
  const otherTokenValue = wallets.ethereumWallet.otherTokens.reduce((totalValue, token) => {
    return totalValue + currency.convertOtherToMicrogon(token as IOtherToken);
  }, 0n);
  return microgonValue + micronotValue + otherTokenValue;
});

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
  return `${prefix}${currency.symbol}${formatMoneyMicrogons(bigIntAbs(offset), '0,0.[0000]')}`;
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

const walletReturnDisplay = Vue.computed(() => {
  const returnPct = stableSwaps.walletSnapshot?.summary.returnPct ?? 0;
  const prefix = returnPct >= 0 ? '+' : '';
  return `${prefix}${numeral(returnPct).format('0,0.[00]')}%`;
});

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
  return `${prefix}${currency.symbol}${formatMoneyMicrogons(bigIntAbs(value))}`;
}

function formatMoneyMicrogons(value: bigint, format = '0,0.00') {
  return numeral(currency.convertMicrogonTo(value, currency.key)).format(format);
}

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

Vue.onMounted(async () => {
  await stableSwaps.load();
});
</script>
