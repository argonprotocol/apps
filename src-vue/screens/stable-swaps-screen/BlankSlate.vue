<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">STABLE SWAPS</header>
        <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-[2.6rem] 2xl:text-5xl">
          Arbitrage the Global Argon Price
        </h1>
        <p class="mx-10 mt-3 flex-col text-xl leading-relaxed text-slate-900/60 xl:mx-16 2xl:mx-auto 2xl:flex">
          <span>When Argon's price on Uniswap drifts from target, Stable Swaps helps you trade</span>
          <span>
            the gaps and return Argon’s price back to target.
            <a
              class="whitespace-nowrap"
              :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/stable-swaps`"
              target="_blank"
            >
              Learn more &raquo;
            </a>
          </span>
        </p>

        <ul class="mt-10 flex w-full flex-row gap-x-4">
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step1Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">1. Watch for Change</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              Monitor this app to see when prices deviate from target.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step2Icon class="text-argon-600/60 mx-auto h-17" />
            <header class="mt-5 mb-1 font-bold">2. Trade the Gaps</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              We show you the exact details of what trades to make.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step3Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">3. Profit from Helping</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              As the price returns to target, you earn a nice profit.
            </p>
          </li>
        </ul>

        <!--        @click="activateStableSwaps"-->
        <span class="relative">
          <button
            disabled
            class="mt-12 cursor-not-allowed rounded-md border border-transparent bg-gray-200 px-12 py-3 text-lg font-bold text-gray-400"
          >
            Activate Stable Swaps
          </button>
        </span>
        <div class="mt-2 text-slate-800/60">Requires a funded ethereum wallet</div>
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/stable-swaps.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { getConfig } from '../../stores/config.ts';
import { NetworkConfig } from '@argonprotocol/apps-core';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';

const config = getConfig();

async function activateStableSwaps() {
  config.hasActivatedStableSwaps = true;
  await config.save();
}
</script>
