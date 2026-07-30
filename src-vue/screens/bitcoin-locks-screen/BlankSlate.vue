<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">BITCOIN LOCKS</header>
        <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-5xl">
          <template v-if="props.isRestoringHistory && props.activeBitcoinLockCount">
            {{ props.activeBitcoinLockCount }} Active Bitcoin
            {{ props.activeBitcoinLockCount === 1 ? 'Lock' : 'Locks' }} Found
          </template>
          <template v-else-if="props.isRestoringHistory">Checking Your Bitcoin History</template>
          <template v-else>Turn Bitcoin Into Liquid Capital</template>
        </h1>
        <p v-if="props.isRestoringHistory" class="mx-10 mt-3 text-xl leading-relaxed text-slate-900/60 xl:mx-28">
          <template v-if="props.activeBitcoinLockCount">
            Restoring the full transaction history, including any released locks.
          </template>
          <template v-else>Looking for active Bitcoin locks and past transactions.</template>
        </p>
        <p v-else class="mx-10 mt-3 flex-col text-xl leading-relaxed text-slate-900/60 xl:mx-10 2xl:mx-auto 2xl:flex">
          <span>Lock your bitcoin at today’s market rate, receive its full value in stablecoins,</span>
          <span>
            and be protected from Bitcoin price drops. Oh, and it maintains chain-of-custody.
            <a
              class="whitespace-nowrap"
              :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`"
              target="_blank"
            >
              Learn more &raquo;
            </a>
          </span>
        </p>
        <Spinner v-if="props.isRestoringHistory" class="mt-8 mr-0" />

        <ul v-if="!props.isRestoringHistory" class="mt-10 flex w-full flex-row gap-x-4">
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step1Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">1. Lock your Bitcoin</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              Your bitcoin's market value is captured at moment of lock.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step2Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">2. Get Stablecoins</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              They're liquid and yours to spend or invest immediately.
            </p>
          </li>
          <li class="w-1/3 rounded-md border border-slate-600/30 px-4 pt-6 pb-4">
            <Step3Icon class="text-argon-600/60 mx-auto h-18" />
            <header class="mt-5 mb-1 font-bold">3. Stay Protected</header>
            <p class="mx-auto max-w-60 leading-relaxed text-slate-900/60">
              If Bitcoin's price falls, the difference is covered.
            </p>
          </li>
        </ul>

        <span v-if="!props.isRestoringHistory" class="relative">
          <button
            data-testid="BitcoinLocks.openLockingOverlay()"
            @click="openLockingOverlay"
            class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md border border-transparent px-12 py-3 text-lg font-bold text-white"
          >
            Liquid Lock Your First Bitcoin
          </button>
          <ArrowCalloutButton
            v-if="controller.activeGuideId === OperationalStepId.LiquidLock && canStartLocking"
            guidance="Start your liquid lock here."
            class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
          />
        </span>
        <div v-if="!props.isRestoringHistory" class="mt-2 text-slate-800/60">
          It only takes a few minutes · Preview is free
        </div>
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
    </div>
  </div>

  <!-- Active lock stats + child rows -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { useFinancials } from '../../stores/financials.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import Spinner from '../../components/Spinner.vue';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';
import { NetworkConfig } from '@argonprotocol/apps-core';

const props = defineProps<{
  isRestoringHistory?: boolean;
  activeBitcoinLockCount?: number;
}>();

const controller = useCertificationController();
const currency = getCurrency();
const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();

const currentTick = Vue.ref(0);
const pageSourcesAreLoaded = Vue.ref(false);

const canStartLocking = Vue.computed(() => {
  return financials.savingsTotalReadyToUse > 0n || !!bitcoinLockCoupons.currentCoupon;
});

function openLockingOverlay() {
  basicEmitter.emit('openBitcoinLock', undefined);
}

let unsubMiningFrames: (() => void) | undefined;

Vue.onMounted(async () => {
  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });
  await Promise.all([currency.isLoadedPromise, bitcoinLocks.load(), miningFrames.load()]);

  currentTick.value = miningFrames.currentTick;
  unsubMiningFrames = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;

  pageSourcesAreLoaded.value = true;
});

Vue.onUnmounted(() => {
  unsubMiningFrames?.();
});
</script>
