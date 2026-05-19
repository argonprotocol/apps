<template>
  <div class="relative flex h-full grow flex-col items-center justify-center px-[5%] pb-5">
    <MoreIcon class="absolute top-4 right-4 h-4 w-4 text-slate-400" />

    <div class="mx-auto flex max-w-200 grow flex-col justify-center pb-10">
      <section class="flex max-h-60 flex-row items-center justify-center py-10">
        <div v-if="financials.savingsTotalPending" class="flex flex-col">
          <div class="text-center whitespace-nowrap">
            <span class="text-argon-700 relative text-7xl font-bold">
              {{ currency.symbol }}
              <FormattedMoney :isLoaded="financials.savingsIsLoaded" :value="financials.savingsTotalPending" />
            </span>
          </div>
          <div class="mt-1 text-center text-lg font-light break-all whitespace-nowrap text-slate-800/80 select-all">
            Waiting to Mint On Chain
          </div>
        </div>
        <div
          v-if="financials.savingsTotalPending"
          class="text-argon-700/30 relative -top-1 -left-1 mx-[3%] text-7xl font-light"
        >
          <ArrowIcon class="text-argon-700/30 h-10" />
          <div class="absolute top-0 left-0 h-full w-10 bg-gradient-to-r from-white from-[5px] to-transparent" />
          <div class="mt-1 text-center text-lg font-light">&nbsp;</div>
        </div>
        <div class="flex flex-col">
          <div class="text-center whitespace-nowrap">
            <span class="text-argon-700 relative text-7xl font-bold">
              {{ currency.symbol }}
              <FormattedMoney :isLoaded="financials.savingsIsLoaded" :value="financials.savingsTotalReadyToUse" />
            </span>
          </div>
          <div class="mt-1 text-center text-lg font-light break-all whitespace-nowrap text-slate-800/80 select-all">
            <template v-if="financials.savingsTotalPending">Ready to Use</template>
            <template v-else>Inflation-Free Savings on the Mainchain</template>
          </div>
        </div>
      </section>

      <section class="border-t border-slate-400/30 py-[4%] whitespace-normal">
        <p class="mx-auto max-w-220 text-[17px]/7 font-light">
          Argon Stablecoin pegs its value to a consumer price index instead of a fiat currency or another centrally
          controlled monetary policy. This ensures a single argon will buy the same amount of goods a century from now
          as it does today. It's wealth that outlasts time.
        </p>
      </section>

      <ul class="text-argon-700/80 mt-0 inline-grid grid-cols-[1fr_1px_1fr] gap-x-5 text-center whitespace-nowrap">
        <li class="flex flex-row items-center justify-center border-y border-slate-400/30 px-4 py-4">
          +{{ numeral(financials.savingsAllTimeReturn).format('0,0.[00]') }}% Buying Power vs
          {{ financials.savingsAllTimeFiatKey }}
          <InfoIcon class="ml-2 inline-block h-5 w-5 text-slate-400" />
        </li>
        <li class="bg-slate-400/30"></li>
        <li class="flex flex-row items-center justify-center border-y border-slate-400/30 px-4 py-4">
          {{ numeral(financials.savingsRestabilizationPower).formatIfElse('< 10', '0,0.[0]', '0,0') }}:1 Restabilization
          Power
          <InfoIcon class="ml-2 inline-block h-5 w-5 text-slate-400" />
        </li>
      </ul>

      <section class="flex flex-row justify-center py-12">
        <button
          @click="openArgonWallet"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow w-7/12 cursor-pointer rounded-md border px-12 py-3 text-lg font-bold text-white focus:outline-none"
        >
          Open Your Argon Wallet
        </button>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrency } from '../../stores/currency.ts';
import MoreIcon from '../../assets/more.svg';
import InfoIcon from '../../assets/info-outline.svg';
import { WalletType } from '../../lib/Wallet.ts';
import numeral from '../../lib/numeral.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ArrowIcon from '../../assets/arrow.svg';
import { useFinancials } from '../stores/financials.ts';

const financials = useFinancials();
const currency = getCurrency();

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.investment });
}
</script>

<style scoped>
@reference "../../main.css";
</style>
