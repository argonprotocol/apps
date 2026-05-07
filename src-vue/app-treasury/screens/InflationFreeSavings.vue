<!-- prettier-ignore -->
<template>
  <div class="relative flex h-full flex-col items-center justify-center grow pb-5 px-[5%] ">
    <MoreIcon class="absolute top-4 right-4 h-4 w-4 text-slate-400" />

    <div class="flex flex-col grow pb-10 mx-auto max-w-300 justify-center">
      <section class="grow max-h-60 py-10 flex flex-col items-center justify-center">
        <div class="whitespace-nowrap text-center">
          <span class="relative text-7xl text-argon-700 font-bold ">
            {{ currency.symbol }}<FormattedMoney :isLoaded="bitcoinLocksIsLoaded" :value="totalValue" />
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
        </div>
        <div class="text-center mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
          Inflation-Free Savings on the Mainchain
        </div>
      </section>

      <section class="grow max-h-40 flex flex-row w-full items-stretch border-t border-slate-400/30">
        <div class="flex flex-col justify-center text-center w-1/2 pl-7 pr-7 pt-7 pb-5">
          <span class="relative text-5xl text-argon-700/80 font-bold ">
            {{ currency.symbol }}<FormattedMoney :isLoaded="currencyIsLoaded" :value="wallets.investmentWallet.availableMicrogons" />
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
          <div class="mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
            Ready to Use
          </div>
        </div>
        <div class="w-px bg-slate-400/30 mx-5" />
        <div class="flex flex-col justify-center text-center w-1/2 pl-5 pr-10 pt-7 pb-5">
          <span class="relative text-5xl text-argon-700/80 font-bold">
            {{ currency.symbol }}<FormattedMoney :isLoaded="bitcoinLocksIsLoaded" :value="pendingMint" />
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
          <div class="mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
            Pending on Chain
          </div>
        </div>
      </section>

      <section class="whitespace-normal border-t border-slate-400/30 py-[4%]">
        <p class="max-w-220 text-[17px]/7 font-light mx-auto">
          Argon's stablecoin ties its value to a consumer price index instead of a fiat currency or other centrally
          controlled monetary policy. A single argon stablecoin is designed to buy the same amount of goods a century
          from now as it does today.
        </p>
      </section>

      <ul class="mt-0 inline-grid grid-cols-2 gap-x-4 text-center text-argon-700/80 whitespace-nowrap">
        <li class="flex flex-row items-center justify-center border-y border-slate-400/30 py-4 px-4">+3.5% Buying Power Over USD <InfoIcon class="w-5 h-5 ml-2 text-slate-400 inline-block" /></li>
        <li class="flex flex-row items-center justify-center border-y border-slate-400/30 py-4 px-4">31:1 Restabilization Power <InfoIcon class="w-5 h-5 ml-2 text-slate-400 inline-block" /></li>
      </ul>

      <section class="flex flex-row justify-center py-12">
        <button @click="openArgonWallet" class="w-7/12 border bg-argon-button border-argon-button-hover hover:bg-argon-button-hover text-white text-lg font-bold inner-button-shadow px-12 py-3 rounded-md cursor-pointer focus:outline-none">
          Open Your Argon Wallet
        </button>
      </section>
    </div>

    <section class="w-full">
      <div v-if="!recentTransactions.length" class="italic text-shadow-slate-600/80">
        Your wallet has no transactions yet.
      </div>
      <header class="font-bold">Recent Transactions</header>
      <table class="w-full">
        <tbody>
        <tr v-for="tx of recentTransactions">
          <td>{{ dayjs.utc(tx.createdAt).local().fromNow() }}</td>
        </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useDebounceFn } from '@vueuse/core';
import { getCurrency } from '../../stores/currency.ts';
import MoreIcon from '../../assets/more.svg';
import InfoIcon from '../../assets/info-outline.svg';
import { WalletType } from '../../lib/Wallet.ts';
import { useWallets } from '../../stores/wallets.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import { IWalletTransferRecord } from '../../lib/db/WalletTransfersTable.ts';

dayjs.extend(utc);

const currency = getCurrency();
const wallets = useWallets();
const bitcoinLocks = getBitcoinLocks();

const currencyIsLoaded = Vue.ref(false);
const bitcoinLocksIsLoaded = Vue.ref(false);
const recentTransactions = Vue.ref<IWalletTransferRecord[]>([]);

const pendingMint = Vue.computed(() => {
  return bitcoinLocks.getMintPending();
});

const rawTotalValue = Vue.computed(() => {
  return wallets.investmentWallet.availableMicrogons + pendingMint.value;
});
const totalValue = Vue.ref(rawTotalValue.value);
const updateTotalValue = useDebounceFn(
  () => {
    totalValue.value = rawTotalValue.value;
  },
  250,
  { maxWait: 750 },
);
const investmentWalletWithBlock = wallets.investmentWallet as typeof wallets.investmentWallet & {
  block?: { blockNumber: number };
};

function openArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.investment });
}

async function loadTransactionHistory() {
  const db = await getDbPromise();
  const allTransfers = await db.walletTransfersTable.fetchAll();
  recentTransactions.value = allTransfers.slice(0, 2);
}

Vue.watch(rawTotalValue, () => {
  void updateTotalValue();
});

Vue.onMounted(async () => {
  currency.isLoadedPromise.then(() => (currencyIsLoaded.value = true));
  await bitcoinLocks.load();
  bitcoinLocksIsLoaded.value = true;

  await loadTransactionHistory();
});
</script>

<style scoped>
@reference "../../main.css";

td {
  @apply border-t border-slate-400/50 py-2;
}
</style>
