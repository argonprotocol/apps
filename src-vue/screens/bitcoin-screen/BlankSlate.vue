<template>
  <div class="flex grow flex-col">
    <div class="flex grow flex-col items-center justify-center">
      <div class="relative flex w-10/12 max-w-300 flex-col items-center py-10 text-center">
        <header class="text-argon-600/70 text-2xl font-normal tracking-widest">BITCOIN LIQUID</header>
        <h1 class="mt-2 text-4xl font-bold opacity-80 xl:text-5xl">Turn Bitcoin Into Liquid Capital</h1>
        <p class="mx-10 mt-3 flex-col text-xl leading-relaxed text-slate-900/60 xl:mx-10 2xl:mx-auto 2xl:flex">
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
        <ul class="mt-10 flex w-full flex-row gap-x-4">
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

        <span class="relative">
          <button
            data-testid="BitcoinLiquids.openCreationOverlay()"
            @click="basicEmitter.emit('openBitcoinLiquidCreationOverlay', undefined)"
            class="bg-argon-button hover:bg-argon-button-hover mt-12 cursor-pointer rounded-md border border-transparent px-12 py-3 text-lg font-bold text-white"
          >
            Create Your First Liquid
          </button>
          <ArrowCalloutButton
            v-if="controller.activeGuideId === OperationalStepId.LiquidLock && canStartLocking"
            guidance="Start your liquid lock here."
            class="absolute top-1/2 right-0 z-50 translate-x-[calc(100%+0.75rem)] -translate-y-1/2"
          />
        </span>
        <div class="mt-2 text-slate-800/60">
          <template v-if="activeCouponGift">
            You've been gifted ${{ activeCouponGift.amount }}, which expires in {{ activeCouponGift.timeRemaining }}
          </template>
          <template v-else>It only takes a few minutes · Preview is free</template>
        </div>
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/bitcoin-locks.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLockCoupons, getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { useFinancials } from '../../stores/financials.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import Step1Icon from './images/step1.svg?component';
import Step2Icon from './images/step2.svg?component';
import Step3Icon from './images/step3.svg?component';
import { NetworkConfig } from '@argonprotocol/apps-core';

const controller = useCertificationController();
const currency = getCurrency();
const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const miningFrames = getMiningFrames();
const currentTick = Vue.ref(0);
const now = Vue.ref(Date.now());
let countdownInterval: ReturnType<typeof setInterval> | undefined;

const canStartLocking = Vue.computed(() => {
  return financials.savingsTotalReadyToUse > 0n || !!bitcoinLockCoupons.currentCoupon;
});

const activeCouponGift = Vue.computed(() => {
  const couponStatus = bitcoinLockCoupons.currentCoupon;
  const expiresAt = couponStatus?.expiresAt ? new Date(couponStatus.expiresAt).getTime() : undefined;
  if (
    !couponStatus ||
    !expiresAt ||
    expiresAt <= now.value ||
    (couponStatus.coupon.expirationTick != null && couponStatus.coupon.expirationTick <= currentTick.value)
  ) {
    return;
  }

  return {
    amount: couponStatus.coupon.estimatedGiftUsd.toFixed(2),
    timeRemaining: formatTimeRemaining(Math.ceil((expiresAt - now.value) / 1_000)),
  };
});

function formatTimeRemaining(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''].filter(Boolean);

  if (parts.length < 2) return parts[0] ?? '0s';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

let unsubMiningFrames: (() => void) | undefined;

Vue.onMounted(async () => {
  countdownInterval = setInterval(() => {
    now.value = Date.now();
  }, 1_000);

  void bitcoinLockCoupons.refresh().catch(error => {
    console.error('Unable to refresh Bitcoin lock coupons', error);
  });
  await Promise.all([currency.isLoadedPromise, bitcoinLocks.load(), miningFrames.load()]);

  currentTick.value = miningFrames.currentTick;
  unsubMiningFrames = miningFrames.onTick(() => {
    currentTick.value = miningFrames.currentTick;
  }).unsubscribe;
});

Vue.onUnmounted(() => {
  clearInterval(countdownInterval);
  unsubMiningFrames?.();
});
</script>
