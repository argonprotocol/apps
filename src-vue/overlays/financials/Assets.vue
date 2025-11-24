<template>
  <div class="Assets Panel flex h-full flex-col space-y-5 px-3 pt-1 pb-5">
    <p class="w-11/12 font-light text-slate-800/70 -mb-5 relative z-20">
      This page presents a breakdown of all your Argon assets, including your mining, vaulting, and the holding accounts.
      Move your mouse over the various items to learn more or click the Move buttons to transfer.
    </p>

    <div class="flex grow flex-col">
      <div class="flex flex-row relative">
        <div class="absolute top-0 left-0 h-3/4 w-full bg-gradient-to-b from-white from-20% to-transparent z-10" />
        <div class="flex h-full w-[30%] flex-col justify-end">
          <header class="text-lg font-bold">Mining Assets</header>
          <div class="mb-5 text-left">{{ abbreviateAddress(wallets.miningWallet.address, 10) }}</div>
        </div>
        <div class="h-full w-[40%] relative">
          <div class="absolute top-[71%] left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center">
            <header class="text-center text-lg font-bold">Holding Account</header>
            <div class="mb-5 text-center">{{ abbreviateAddress(wallets.holdingWallet.address, 10) }}</div>
          </div>
          <BanklessTop1 class="w-full" />
        </div>
        <div class="flex h-full w-[30%] flex-col justify-end">
          <header class="text-right text-lg font-bold">Vaulting Assets</header>
          <div class="mb-5 text-right">{{ abbreviateAddress(wallets.vaultingWallet.address, 10) }}</div>
        </div>
      </div>

      <div class="flex grow flex-row">
        <div class="h-full w-[30%] pr-20">
          <MiningAssetBreakdown class="h-full" show="AllExceptTotal" />
        </div>
        <div class="flex h-full w-[40%] flex-col">
          <BanklessTop2 class="w-full" />
          <div class="relative -my-px w-full grow">
            <BanklessMiddle class="h-full w-full" />
            <div class="absolute top-0 left-0 flex h-full w-full flex-col justify-around text-slate-600/70">
              <div class="flex flex-col items-center justify-center pt-10 text-2xl font-bold">
                <div>32,384</div>
                ARGN
                <div class="text-base font-light">( {{ currency.symbol }}453.43 )</div>
              </div>
              <div class="flex flex-col items-center justify-center pb-10 text-2xl font-bold">
                <div>32,384</div>
                ARGNOT
                <div class="text-base font-light">( {{ currency.symbol }}453.43 )</div>
              </div>
            </div>
          </div>
          <BanklessBottom1 class="w-full" />
        </div>
        <div class="h-full w-[30%] pl-20">
          <VaultingAssetBreakdown class="h-full" show="AllExceptTotal" />
        </div>
      </div>

      <div class="flex flex-row">
        <div class="text-md h-full w-[30%] pr-20">
          <MiningAssetBreakdown class="h-full" show="OnlyTotal" />
        </div>
        <div class="h-full w-[40%]">
          <BanklessBottom2 class="w-full" />
        </div>
        <div class="h-full w-[30%] pl-20">
          <VaultingAssetBreakdown class="h-full" show="OnlyTotal" />
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import VaultingAssetBreakdown from '../../components/VaultingAssetBreakdown.vue';
import MiningAssetBreakdown from '../../components/MiningAssetBreakdown.vue';
import BanklessTop1 from '../../assets/bankless-top1.svg';
import BanklessTop2 from '../../assets/bankless-top2.svg';
import BanklessMiddle from '../../assets/bankless-middle.svg';
import BanklessBottom1 from '../../assets/bankless-bottom1.svg';
import BanklessBottom2 from '../../assets/bankless-bottom2.svg';
import { useWallets } from '../../stores/wallets.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import { toRaw } from 'vue';
import * as Vue from 'vue';
import { HoverCardArrow, HoverCardContent, HoverCardRoot, HoverCardTrigger } from 'reka-ui';
import { useCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';

const wallets = useWallets();
const currency = useCurrency();
const breakdown = useMiningAssetBreakdown();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

// async function activateMicrogons() {
//   const startRules = JsonExt.stringify(toRaw(config.biddingRules));
//   config.biddingRules.sidelinedMicrogons -= sidelinedMicrogons.value;
//   await saveUpdatedBiddingRules(startRules);
// }
//
// async function activateMicronots() {
//   const startRules = JsonExt.stringify(toRaw(config.biddingRules));
//   config.biddingRules.sidelinedMicronots -= sidelinedMicronots.value;
//   await saveUpdatedBiddingRules(startRules);
// }
//
// async function sidelineMicronots() {
//   const startRules = JsonExt.stringify(toRaw(config.biddingRules));
//   config.biddingRules.sidelinedMicronots += breakdown.unusedMicronots;
//   await saveUpdatedBiddingRules(startRules);
// }
//
// async function sidelineMicrogons() {
//   const startRules = JsonExt.stringify(toRaw(config.biddingRules));
//   config.biddingRules.sidelinedMicrogons += breakdown.unusedMicrogons;
//   await saveUpdatedBiddingRules(startRules);
// }

const isUpdatingRules = Vue.ref(false);
const ruleUpdateError = Vue.ref('');

// const sidelinedMicrogons = Vue.computed(() => {
//   if (wallets.miningWallet.availableMicrogons >= config.biddingRules.sidelinedMicrogons) {
//     return config.biddingRules.sidelinedMicrogons;
//   }
//   return 0n;
// });
//
// const sidelinedMicronots = Vue.computed(() => {
//   if (wallets.miningWallet.availableMicronots >= config.biddingRules.sidelinedMicronots) {
//     return config.biddingRules.sidelinedMicronots;
//   }
//   return 0n;
// });
//
// async function saveUpdatedBiddingRules(startRules: string) {
//   try {
//     isUpdatingRules.value = true;
//     await bot.resyncBiddingRules();
//     config.saveBiddingRules();
//   } catch (e) {
//     ruleUpdateError.value = `Sorry, this allocation failed. Details: ${String(e)}`;
//     config.biddingRules = JsonExt.parse(startRules);
//   } finally {
//     isUpdatingRules.value = false;
//   }
// }
</script>

<style>
@reference "../../main.css";

.Assets.Panel {
  .hasStroke {
    @apply stroke-1;
  }
}
</style>
