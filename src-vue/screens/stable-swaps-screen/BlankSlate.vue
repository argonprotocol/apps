<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">MARKET STABILIZERS</header>
        <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-[2.6rem] 2xl:text-5xl">
          Become a Member of the Financial Elite
        </h1>
        <p class="mx-10 mt-3 flex-col text-xl leading-relaxed text-slate-900/60 xl:mx-16 2xl:mx-auto 2xl:flex">
          <span>Stablizers provide the liquidity needed for global trading markets to function</span>
          <span>
            efficiently in both short-term and long-term capacities.
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
            <header class="mt-5 mb-1 font-bold">1. Set Your Positions</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              You decide how you want to allocate your capital.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step2Icon class="text-argon-600/60 mx-auto h-17" />
            <header class="mt-5 mb-1 font-bold">2. Working Capital</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              As trades are executed, your capital provides the liquidity.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step3Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">3. Profit from Helping</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              You earn both Uniswap fees and a share of Argon revenue.
            </p>
          </li>
        </ul>

        <span class="relative">
          <button
            @click="isCreateStabilizerOpen = true"
            class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md border border-transparent px-12 py-3 text-lg font-bold text-white"
          >
            Activate Your First Stabilizer
          </button>
        </span>
        <div class="mt-2 text-slate-800/60">Requires an ethereum wallet connector</div>
      </div>
    </div>
    <CreateStabilizer :isOpen="isCreateStabilizerOpen" @close="isCreateStabilizerOpen = false" />
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/stable-swaps.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import CreateStabilizer from '../../overlays/CreateStabilizer.vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';

const isCreateStabilizerOpen = ref(false);
</script>
