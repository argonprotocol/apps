<!-- prettier-ignore -->
<template>
  <div class="relative flex h-full flex-col items-center justify-center grow pb-5 px-[5%] ">
    <MoreIcon class="absolute top-4 right-4 h-4 w-4 text-slate-400" />

    <div class="flex flex-col grow pb-40 mx-auto max-w-300 justify-center">
      <section class="grow max-h-60 py-10 flex flex-col items-center justify-center">
        <div class="whitespace-nowrap text-center">
          <span class="relative text-7xl text-slate-600 font-bold ">
            {{ currency.symbol }}<FormattedMoney :isLoaded="bitcoinLocksIsLoaded" :value="totalBitcoinDebt" />
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
        </div>
        <div class="text-center mt-1 text-lg font-light text-slate-600 break-all select-all whitespace-nowrap">
          Outstanding Debt
        </div>
      </section>

      <section class="grow max-h-40 flex flex-row w-full items-stretch border-t border-slate-400/30">
        <div class="flex flex-col justify-center text-center w-1/2 pl-7 pr-7 pt-7 pb-5">
          <span class="relative text-5xl text-slate-700/80 font-bold ">
            {{ allLocks.length }}
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
          <div class="mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
            Active Position{{ allLocks.length === 1 ? '' : 's' }}
          </div>
        </div>
        <div class="w-px bg-slate-400/30 mx-5" />
        <div class="flex flex-col justify-center text-center w-1/2 pl-5 pr-10 pt-7 pb-5">
          <span class="relative text-5xl text-slate-700/80 font-bold">
            11 Days
            <span class="flex flex-row gap-x-1 absolute -top-3 -right-1 translate-y-full translate-x-full">
              <InfoIcon class="w-5 h-5 text-slate-400" />
            </span>
          </span>
          <div class="mt-1 text-lg font-light text-slate-800 break-all select-all whitespace-nowrap">
            Until Next Maturity
          </div>
        </div>
      </section>

      <section class="whitespace-normal border-y border-slate-400/30 py-[4%]">
        <p class="max-w-220 text-[17px]/7 font-light mx-auto">
          Argon's stablecoin ties its value to a consumer price index instead of a fiat currency or other centrally
          controlled monetary policy. A single argon stablecoin is designed to buy the same amount of goods a century
          from now as it does today.
        </p>
      </section>
    </div>

    <section class="w-full">
      <div v-if="!recentTransactions.length" class="italic text-shadow-slate-600/80">
        Your wallet has no transactions yet.
      </div>
      <header class="font-bold">Upcoming Payment Dates</header>
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
import { BitcoinLock } from '@argonprotocol/mainchain';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';

dayjs.extend(utc);

const currency = getCurrency();
const wallets = useWallets();
const bitcoinLocks = getBitcoinLocks();

const isLoaded = Vue.ref(false);
const currencyIsLoaded = Vue.ref(false);
const bitcoinLocksIsLoaded = Vue.ref(false);
const totalBitcoinDebt = Vue.ref(0n);

const recentTransactions = Vue.ref<IWalletTransferRecord[]>([]);

const allLocks = Vue.computed(() => {
  return bitcoinLocks.getAllLocks();
});

const nonReleasedLocks = Vue.computed(() => {
  return allLocks.value.filter(l => l.status !== BitcoinLockStatus.Released);
});

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

async function updateTotalBitcoinDebt() {
  const ratePromises = nonReleasedLocks.value.map(lock => {
    return BitcoinLock.getRedemptionRate(currency.priceIndex, lock).catch(() => 0n);
  });
  const rates = await Promise.all(ratePromises);
  totalBitcoinDebt.value = rates.reduce((sum, r) => sum + r, 0n);
}

Vue.watch([nonReleasedLocks, isLoaded], () => {
  void updateTotalBitcoinDebt();
});

Vue.watch(rawTotalValue, () => {
  void updateTotalValue();
});

Vue.watch([pendingMint, totalValue], () => {
  console.log({
    walletBlockNumber: investmentWalletWithBlock.block?.blockNumber,
    bitcoinBlockNumber: bitcoinLocks.data.latestArgonBlockHeight,
    walletAmount: wallets.investmentWallet.availableMicrogons,
    bitcoinAmount: bitcoinLocks.getMintPending(),
    total: wallets.investmentWallet.availableMicrogons + bitcoinLocks.getMintPending(),
  });
});

Vue.onMounted(async () => {
  currency.isLoadedPromise.then(() => (currencyIsLoaded.value = true));
  await bitcoinLocks.load();
  bitcoinLocksIsLoaded.value = true;

  void updateTotalBitcoinDebt();
  await loadTransactionHistory();
});
</script>

<style scoped>
@reference "../../main.css";

td {
  @apply border-t border-slate-400/50 py-2;
}
</style>
