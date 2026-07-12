<template>
  <div v-if="!config.hasExtensionTreasury" class="flex h-full flex-col px-5 py-5">
    <section box class="mx-auto flex w-full max-w-4xl flex-col px-6 py-6">
      <AdForTreasury @claimed="onTreasuryInviteClaimed" />
    </section>
  </div>

  <div v-else class="flex flex-row justify-center gap-x-5 pt-5">
    <section box class="flex min-h-60 w-1/3 flex-col px-2">
      <header class="flex flex-row border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase">
        <span class="grow pl-3">Argon Bonds</span>
      </header>
      <div class="flex grow flex-col px-3">
        <p class="grow pt-3 pb-2 font-light text-slate-900/80">
          Argon Bonds give you direct exposure to the profit returns of Argon's Stabilization Vaults.
        </p>
        <button
          @click="openBonds"
          class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-3 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white"
        >
          Purchase Argon Bonds
          <ChevronDoubleRightIcon class="relative ml-1 size-5" />
        </button>
      </div>
    </section>

    <section box class="flex min-h-60 w-1/3 flex-col px-2">
      <header
        class="flex flex-row items-center border-b border-slate-400/30 py-2 text-[18px] font-bold text-slate-900/80 uppercase"
      >
        <span class="grow pl-3">Bitcoin Liquid Locks</span>
      </header>
      <div class="flex grow flex-col px-3">
        <p class="pt-3 pb-2 font-light text-slate-900/80">
          Argon Liquid Locking converts the full market value of your Bitcoin into unencumbered stablecoins.
        </p>
        <div
          v-if="bitcoinLockCoupons.currentCoupon && bitcoinLockCoupons.couponOfferLiquidityMicrogons !== undefined"
          class="bg-argon-50/35 border-argon-300/70 mt-2 flex items-start gap-3 rounded-md border px-4 py-3 text-sm text-slate-800"
        >
          <GiftIcon class="text-argon-500 mt-0.5 h-5 w-5 shrink-0" />
          <div>
            {{ couponProviderLabel }} is gifting your first liquid lock for free, up to {{ currency.symbol
            }}{{ microgonToMoneyNm(bitcoinLockCoupons.couponOfferLiquidityMicrogons).format('0,0') }}!
          </div>
        </div>
        <button
          @click="openBitcoinLocks"
          class="bg-argon-500 hover:bg-argon-600 border-argon-700 inner-button-shadow my-3 flex w-full max-w-180 cursor-pointer flex-row items-center justify-center rounded-md border px-5 py-2 text-lg font-bold text-white"
        >
          Liquid Lock Your Bitcoin
          <ChevronDoubleRightIcon class="relative ml-1 size-5" />
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';
import GiftIcon from '../assets/gift.svg?component';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import AdForTreasury from './network-screen/AdForTreasury.vue';
import { getConfig } from '../stores/config.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getCurrency } from '../stores/currency.ts';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';

const config = getConfig();
const controller = useCertificationController();
const currency = getCurrency();
const bitcoinLockCoupons = getBitcoinLockCoupons();

const { microgonToMoneyNm } = createNumeralHelpers(currency);
const couponProviderLabel = config.upstreamOperator?.name || 'The vault operator';

function onTreasuryInviteClaimed() {
  controller.setTab(TopTab.BitcoinLocks);
}

function openBonds() {
  controller.setTab(TopTab.ArgonBonds);
}

function openBitcoinLocks() {
  controller.setTab(TopTab.BitcoinLocks);
}
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}
</style>
