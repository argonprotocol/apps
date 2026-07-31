<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @pressEsc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="text-2xl font-bold grow">Sponsor Details</div>
    </template>
    <div class="px-6 py-4 text-base font-medium text-gray-700">
      <div v-if="!isLoaded" class="text-center">
        Loading
      </div>
      <div v-else>
        <p class="font-light leading-6">
          You must be invited by an operator of the network to use Argon's advanced features like Treasury and
          Operations.
        </p>

        <ul class="my-5 grid grid-cols-[130px_1fr] border-y border-slate-300/70">
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Name</span>
            <span class="border-b border-slate-200 py-3">{{ config.upstreamOperator?.name || '--' }}</span>
          </li>
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Account ID</span>
            <span class="selectable-text border-b border-slate-200 py-3 break-all">
              {{ config.upstreamOperator?.accountId || '--' }}
            </span>
          </li>
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Server</span>
            <span class="selectable-text border-b border-slate-200 py-3">
              {{ config.bootstrapDetails?.routerHost || '--' }}
            </span>
          </li>
          <li class="contents">
            <span class="py-3 text-gray-500">Connection</span>
            <span class="py-3">{{ config.bootstrapDetails?.type || '--' }}</span>
          </li>
          <li v-if="estimatedLockGift" class="contents">
            <span class="py-3 text-gray-500">Gifts</span>
            <span class="py-3">
              Up to {{ currency.symbol }}{{ microgonToMoneyNm(estimatedLockGift).format('0,0.00') }} in bitcoin locking fees
              <template v-if="couponExpiresAt">
                <template v-if="couponTimeRemaining">(expires in {{ couponTimeRemaining }})</template>
                <template v-else>(expired)</template>
              </template>
            </span>
          </li>
        </ul>

        <p class="font-light leading-6 text-gray-600">
          Your sponsor provided you the access code to upgrade to Treasury services. They never receive your wallet
          keys or other private details.
        </p>
      </div>

    </div>
  </OverlayBase>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { BitcoinLock } from '@argonprotocol/mainchain';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';
import { createNumeralHelpers } from '../lib/numeral';
import { getCurrency } from '../stores/currency.ts';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import { getVaults } from '../stores/vaults.ts';

const config = getConfig();
const currency = getCurrency();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const vaults = getVaults();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const now = Vue.ref(Date.now());
let countdownInterval: ReturnType<typeof setInterval> | undefined;

const estimatedLockGift = Vue.computed(() => {
  const coupon = bitcoinLockCoupons.currentCoupon;
  if (!coupon) return;

  const vault = vaults.vaultsById[coupon.coupon.vaultId];
  if (!vault) return;

  const fullLockAmount = BitcoinLock.calculateRedemptionAmountFromSatoshis(
    currency.priceIndex,
    coupon.coupon.maxSatoshis,
  );
  return vault.calculateBitcoinFee(fullLockAmount);
});

const couponExpiresAt = Vue.computed(() => {
  const expiresAt = bitcoinLockCoupons.currentCoupon?.expiresAt;
  return expiresAt ? new Date(expiresAt).getTime() : undefined;
});

const couponTimeRemaining = Vue.computed(() => {
  if (!couponExpiresAt.value) return;

  const totalSeconds = Math.max(0, Math.ceil((couponExpiresAt.value - now.value) / 1_000));
  if (totalSeconds === 0) return;

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
});

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openSponsorOverlay', () => {
  isOpen.value = true;
});

Vue.onMounted(async () => {
  countdownInterval = setInterval(() => {
    now.value = Date.now();
  }, 1_000);

  await config.load();
  isLoaded.value = true;
});

Vue.onUnmounted(() => clearInterval(countdownInterval));
</script>
