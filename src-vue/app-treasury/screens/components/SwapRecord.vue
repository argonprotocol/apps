<template>
  <div class="SwapRecord Component flex flex-col">
    <section
      :ActiveRecord="walletOutputAmount ? true : undefined"
      :DisabledRecord="walletOutputAmount ? undefined : true"
      :class="isActionHovered ? '' : 'hover:bg-slate-50'"
    >
      <div class="rounded border border-slate-500/20 px-2 py-4 text-center">
        <div :class="walletOutputAmount ? 'text-argon-600' : 'text-slate-600/90'" class="text-4xl font-bold">
          {{ swap.returnPct > 0 ? '+' : '' }}{{ numeral(swap.returnPct).format('0,0.[00]') }}%
        </div>
        <div :class="walletOutputAmount ? 'text-argon-600/70' : 'text-slate-600/90'" class="mt-1 text-sm font-bold">
          ON ETHEREUM
        </div>
      </div>
      <div ContentWrapper>
        <div FirstRow>
          <header class="flex flex-row items-center gap-x-2">
            <span>
              {{
                microgonToNm(swap.inputAmountMicrogons, swap.inputToken).format(
                  swap.inputToken === UnitOfMeasurement.ETH ? '0,0.[0000000000]' : '0,0.00',
                )
              }}
              {{ swap.inputToken }}
            </span>
            <ArrowLongRightIcon class="h-10 opacity-50" />
            <span>{{ microgonToArgonNm(swap.outputAmount).format('0,0.[000000]') }} ARGN</span>
          </header>
          <div
            class="text-md flex grow flex-row items-center justify-end gap-x-2 text-right"
            @mouseenter="isActionHovered = true"
            @mouseleave="isActionHovered = false"
          >
            <button
              @click.stop="openCurrentTrade()"
              :class="
                walletOutputAmount
                  ? 'bg-argon-600 border-argon-800 hover:bg-argon-700 cursor-pointer text-white hover:shadow-lg'
                  : 'border-slate-600/30 bg-white text-slate-600/30'
              "
              class="rounded-md border px-5"
            >
              Start Swap
            </button>
          </div>
        </div>
        <div SecondRow>
          <span v-if="!walletOutputAmount">Your wallet needs {{ swap.inputToken }} before it can swap.</span>
          <span v-else-if="walletOutputAmount === swap.outputAmount">
            Your wallet has enough {{ swap.inputToken }} to fully execute this swap.
          </span>
          <span v-else>
            Your wallet has
            {{
              microgonToNm(walletInputAmount, swap.inputToken).format(
                swap.inputToken === UnitOfMeasurement.ETH ? '0,0.[0000000000]' : '0,0.00',
              )
            }}
            {{ swap.inputToken }}, which can acquire
            {{ microgonToArgonNm(walletOutputAmount).format('0,0.[000000]') }} ARGN
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { IStableSwap } from '../../../interfaces/IStableSwap.ts';
import { ArrowLongRightIcon } from '@heroicons/vue/24/outline';
import { useWallets } from '../../../stores/wallets.ts';
import { bigIntMin, bigNumberToBigInt, UnitOfMeasurement } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { StableSwaps } from '../../../lib/StableSwaps.ts';

dayjs.extend(utc);

const currency = getCurrency();
const wallets = useWallets();

const { microgonToArgonNm, microgonToNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    swap: IStableSwap;
  }>(),
  {},
);

const isActionHovered = Vue.ref(false);

const walletInputAmount = Vue.computed(() => {
  let amount = 0n;

  if (props.swap.inputToken === UnitOfMeasurement.ARGNOT) {
    const micronots = wallets.ethereumWallet.availableMicronots;
    amount = currency.convertMicronotTo(micronots, UnitOfMeasurement.Microgon);
  } else {
    const otherToken = wallets.ethereumWallet.otherTokens.find(x => x.symbol === props.swap.inputToken);
    if (otherToken) {
      amount = currency.convertOtherToMicrogon(otherToken);
    }
  }

  return bigIntMin(amount, props.swap.inputAmountMicrogons);
});

const walletOutputAmount = Vue.computed(() => {
  const factor = BigNumber(walletInputAmount.value).dividedBy(props.swap.inputAmountMicrogons).toNumber();
  const amount = BigNumber(props.swap.outputAmount).multipliedBy(factor);
  return bigNumberToBigInt(amount);
});

async function openCurrentTrade() {
  const inputCurrency = await StableSwaps.getInputCurrency(props.swap.inputToken);
  if (!inputCurrency && props.swap.inputToken !== UnitOfMeasurement.ETH) return;

  const swapUrl = await StableSwaps.buildStableSwapUniswapUrl(walletOutputAmount.value, inputCurrency);
  if (!swapUrl) return;

  await tauriOpenUrl(swapUrl);
}
</script>

<style>
@reference "../../../main.css";

.SwapRecord.Component {
  section[DisabledRecord] {
    @apply flex flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 opacity-50;
    [MainIcon] {
      @apply opacity-50;
    }
  }

  section[ActiveRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 shadow hover:bg-slate-50;
  }

  [ContentWrapper] {
    @apply grow pl-2;

    button[PrimaryButton] {
      @apply bg-argon-600 border-argon-800 text-md hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap text-white hover:shadow-lg;
    }

    button[SecondaryButton] {
      @apply border-argon-800/50 text-md text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white hover:shadow-lg;
    }

    [FirstRow] {
      @apply flex flex-row items-center gap-1 pt-3 pb-2 text-lg text-slate-800;
      header {
        @apply relative top-1 grow text-lg font-bold;
      }
    }

    [SecondRow] {
      @apply flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500;
    }
  }

  [MainIcon] {
    @apply w-20 text-slate-400;
  }
  /* relative top-px mr-7 inline-block w-18 -rotate-24 opacity-60 */

  .fade-in-out {
    animation: fadeInOut 1s ease-in-out infinite;
  }

  .fade-in-out:hover {
    animation: none;
  }

  .bitcoin-spin {
    animation: bitcoinSpin 2s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}

@keyframes fadeInOut {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.85;
  }
}

@keyframes bitcoinSpin {
  0% {
    rotate: 0deg;
  }
  90% {
    rotate: 360deg;
  }
  100% {
    rotate: 360deg;
  }
}
</style>
