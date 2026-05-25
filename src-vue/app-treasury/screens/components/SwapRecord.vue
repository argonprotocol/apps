<template>
  <div class="SwapRecord Component flex flex-col">
    <section ActiveRecord :class="isActionHovered ? '' : 'hover:bg-slate-50'">
      <div class="rounded border border-slate-500/20 px-2 py-4 text-center">
        <div class="text-argon-600 text-4xl font-bold">+{{ numeral(swap.returnPct).format('0,0.[00]') }}%</div>
        <div class="mt-1 text-sm font-bold text-slate-600/70">ON ETHEREUM</div>
      </div>
      <div ContentWrapper>
        <div FirstRow>
          <div class="flex flex-row items-center gap-x-2 text-xl font-bold">
            <span>
              {{ microgonToNm(swap.inputAmount, swap.inputToken).format('0,0.[000000]') }} {{ swap.inputToken }}
            </span>
            <ArrowLongRightIcon class="h-10 opacity-50" />
            <span>{{ microgonToArgonNm(swap.outputAmount).format('0,0.[000000]') }} ARGN</span>
          </div>
          <div
            class="text-md flex grow flex-row items-center justify-end gap-x-2 text-right"
            @mouseenter="isActionHovered = true"
            @mouseleave="isActionHovered = false"
          >
            <button
              @click.stop="openCurrentTrade()"
              class="bg-argon-600 border-argon-800 hover:bg-argon-700 cursor-pointer rounded-md border px-5 text-white hover:shadow-lg"
            >
              Start Swap
            </button>
          </div>
        </div>
        <div SecondRow>
          <span>
            Your wallet has
            {{ currency.symbol }}{{ microgonToMoneyNm(0n).format('0,0.00') }} {{ swap.inputToken }}, which will acquire
            {{ currency.symbol }}{{ microgonToMoneyNm(0n).format('0,0.00') }} ARGN
          </span>
        </div>
      </div>
    </section>
  </div>
  <!--  <div>Argons to Buy:-->
  <!--    {{ microgonToArgonNm(stableSwaps.marketSnapshot.discountedEthereumArgonAmount ?? 0n).format('0,0.[0000]') }}-->
  <!--  </div>-->
  <!--  <div>ARGN Current Price: {{ currency.symbol-->
  <!--    }}{{-->
  <!--      microgonToMoneyNm(stableSwaps.marketSnapshot.currentPriceMicrogons || 0n).format('0,0.[0000]')-->
  <!--    }}-->
  <!--  </div>-->
  <!--  <div>Expected Profit: {{ currency.symbol-->
  <!--    }}{{ microgonToMoneyNm(stableSwaps.marketSnapshot?.projectedProfitMicrogons ?? 0n).format('0,0.00') }}-->
  <!--  </div>-->
  <!--  <div>Estimated Spend:-->
  <!--    <span class="font-medium text-slate-700">{{ currency.symbol }}{{ microgonToMoneyNm(stableSwaps.marketSnapshot?.costToTargetMicrogons || 0n).format('0,0.00') }}</span>-->
  <!--  </div>-->
  <!--  <div>Offset from Target: {{ stableSwaps.marketSnapshot.targetPriceOffset < 0 ? '-' : '+'-->
  <!--    }}{{ currency.symbol-->
  <!--    }}{{ microgonToMoneyNm(bigIntAbs(stableSwaps.marketSnapshot.targetPriceOffset)).format('0,0.[0000]') }}-->
  <!--  </div>-->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getMiningFrames } from '../../../stores/mainchain.ts';
import { IStableSwap } from '../../../interfaces/IStableSwap.ts';
import { ArrowLongRightIcon } from '@heroicons/vue/24/outline';
import { useStableSwaps } from '../../stores/stableSwaps.ts';

dayjs.extend(utc);

const currency = getCurrency();
const miningFrames = getMiningFrames();
const stableSwaps = useStableSwaps();

const { microgonToMoneyNm, microgonToArgonNm, microgonToNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    swap: IStableSwap;
  }>(),
  {},
);

const isActionHovered = Vue.ref(false);

async function openCurrentTrade() {
  if (!props.swap.tradeUrl) return;

  await tauriOpenUrl(props.swap.tradeUrl);
}
</script>

<style>
@reference "../../../main.css";

.SwapRecord.Component {
  section[PendingRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 hover:bg-slate-50/50;
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
