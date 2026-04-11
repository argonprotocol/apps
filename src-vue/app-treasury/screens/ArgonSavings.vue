<!-- prettier-ignore -->
<template>
  <div class="relative flex h-full flex-col items-center justify-center grow px-6 py-4">
    <MoreIcon class="absolute top-4 right-4 h-4 w-4 text-slate-400" />
    <div class="flex w-fit max-w-full flex-col pb-10">
      <div class="text-center text-7xl text-argon-700 font-bold whitespace-nowrap">
        <span class="relative">
          {{ currency.symbol }}{{ totalNetWorth[0] }}.<span class="opacity-40">{{ totalNetWorth[1] }}</span>
          <span class="flex flex-row gap-x-1 absolute top-0 -right-1 translate-y-full translate-x-full">
            <InfoIcon class="w-5 h-5 text-slate-400" />
            <CopyAddressMenu :walletType="WalletType.investment" />
          </span>
        </span>
      </div>
      <div class="text-center mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
        Inflation-Free Savings on Mainchain
        <!--        {{ walletKeys.investmentAddress }}-->
      </div>

      <p class="w-0 min-w-full whitespace-normal border-t border-slate-400/50 pt-4 mt-4 text-[17px]/7 font-light">
        Argon’s stablecoin is inflation-free by default. Its value is tied to a consumer price index instead of a fiat currency or other centrally controlled monetary policy. A single argon stablecoin is designed to buy the same amount of goods a century from now as it does today.
      </p>

      <ul class="mt-6 inline-grid grid-cols-2 gap-x-4 text-center text-argon-700/80 whitespace-nowrap">
        <li class="border-y border-slate-400/50 py-2 px-4">+3.5% Buying Power Over USD</li>
        <li class="border-y border-slate-400/50 py-2 px-4">31:1 Restabilization Power</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrency } from '../../stores/currency.ts';
import MoreIcon from '../../assets/more.svg';
import InfoIcon from '../../assets/info-outline.svg';
import { WalletType } from '../../lib/Wallet.ts';
import CopyAddressMenu from '../../app-operations/screens/components/CopyAddressMenu.vue';
import * as Vue from 'vue';
import { IS_OPERATIONS_APP } from '../../lib/Env.ts';
import { useWallets } from '../../stores/wallets.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';

const currency = getCurrency();
const wallets = useWallets();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const totalNetWorth = Vue.computed(() => {
  if (!currency.isLoaded) {
    return ['--', '--'];
  }
  let rawValue: bigint;
  if (IS_OPERATIONS_APP) {
    rawValue = wallets.totalOperationalResources;
  } else {
    rawValue = wallets.totalTreasuryResources;
  }
  const value = microgonToMoneyNm(rawValue).format('0,0.00');
  return value.split('.');
});
</script>
