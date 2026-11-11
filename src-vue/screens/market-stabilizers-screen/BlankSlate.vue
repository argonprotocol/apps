<template>
  <div class="flex grow flex-col items-center justify-center">
    <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
      <header class="text-argon-600/70 text-2xl font-normal tracking-widest">MARKET STABILIZERS</header>
      <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-4xl 2xl:text-5xl">
        Become a Member of the Financial Elite
      </h1>
      <p class="mx-10 mt-3 text-xl leading-relaxed text-slate-900/60">
        Set a buying alert, review opportunities when they arise, and choose when to buy ARGN and bid for a bonus.
      </p>
      <ul class="mt-10 flex w-full flex-row gap-x-4">
        <li class="w-1/3 rounded-md border border-slate-600/30 bg-white px-4 pt-6 pb-4">
          <Step1Icon class="text-argon-600/60 mx-auto h-18" />
          <header class="mt-5 mb-1 font-bold">1. Set Your Buy Alert</header>
          <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
            Choose the minimum estimated return that should trigger a buying alert.
          </p>
        </li>
        <li class="w-1/3 rounded-md border border-slate-600/30 bg-white px-4 pt-6 pb-4">
          <Step2Icon class="text-argon-600/60 mx-auto h-18" />
          <header class="mt-5 mb-1 font-bold">2. Review a Buying Opportunity</header>
          <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
            When notified, review the price, fees, and holding period before choosing to buy.
          </p>
        </li>
        <li class="w-1/3 rounded-md border border-slate-600/30 bg-white px-4 pt-6 pb-4">
          <Step3Icon class="text-argon-600/60 mx-auto h-18" />
          <header class="mt-5 mb-1 font-bold">3. Bid and Hold Your ARGN</header>
          <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
            After buying, bid for a bonus. Your purchased ARGN becomes usable after its holding period.
          </p>
        </li>
      </ul>
      <button
        type="button"
        :disabled="!canActivate"
        class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md border border-transparent px-12 py-3 text-lg font-bold text-white disabled:cursor-default disabled:opacity-40"
        @click="emit('create')"
      >
        Get Started
      </button>
      <div class="mt-2 text-slate-800/60">
        Requires a connected Ethereum account with ETH and USDC.
        <a :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers/remote-wallet-connectors`" target="_blank">
          View Docs &raquo;
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NetworkConfig } from '@argonprotocol/apps-core';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';

const emit = defineEmits<{ create: [] }>();
defineProps<{ canActivate: boolean }>();
</script>
