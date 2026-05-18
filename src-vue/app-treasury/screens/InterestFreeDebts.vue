<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col px-9">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <!-- Blank state -->
    <div v-else-if="!allLocks.length" class="flex grow flex-col items-center justify-center pb-20">
      <div class="flex w-7/12 max-w-200 flex-col items-center pb-10">
        <div class="w-20 bg-white shadow-md">
          <LoanIcon class="text-argon-600/60 inline-block w-full" />
        </div>
        <p class="mt-10 w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
          The Argon Network provides interest-free loans to all bitcoin holders up to the full market value of their
          bitcoin. These loans are for a duration of one year, after which you can continue to extend it for additional
          years. The stablecoins you receive are unencumbered, meaning you have the full freedom to deploy your capital
          however you want.
        </p>
        <div class=" mt-12">
          <button @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)" class="text-argon-600 text-base font-bold cursor-pointer border border-argon-600 px-5 py-1 rounded-md hover:bg-argon-600/5">
            Open Bitcoin Locks Tab
            <ArrowRightIcon class="w-5 h-5 inline-block ml-1" />
          </button>
        </div>
      </div>
    </div>

    <div v-else class="min-h-0 grow flex flex-col">
      <section class="mt-5 flex flex-row items-end gap-x-2 text-center px-9">
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            {{ currency.symbol }}<FormattedMoney :isLoaded="bitcoinLocksIsLoaded" :value="totalBitcoinDebt" />
          </div>
          <div class="font-light text-slate-900/70">Outstanding Debt</div>
        </div>
        <div class="relative h-full w-px bg-slate-400/30"/>
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            {{ allLocks.length }}
          </div>
          <div class="font-light text-slate-900/70">
            Active Position{{ allLocks.length === 1 ? '' : 's' }}
          </div>
        </div>
        <div class="relative h-full w-px bg-slate-400/30"/>
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            {{ closestMaturityDays }} Days
          </div>
          <div class="font-light text-slate-900/70">
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

      <section class="w-full">
        <div v-if="!sortedLocks.length" class="italic text-shadow-slate-600/80 text-center pt-50">
          No upcoming payments
        </div>
        <template v-if="sortedLocks.length">
          <header class="font-bold">Upcoming Payment Dates</header>
          <table class="w-full">
            <tbody>
              <tr v-for="lock of sortedLocks">
                <td>{{ dayjs.utc(lock.createdAt).local().fromNow() }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { getCurrency } from '../../stores/currency.ts';
import InfoIcon from '../../assets/info-outline.svg';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { BitcoinLock } from '@argonprotocol/mainchain';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';
import LoanIcon from '../../assets/loan.svg';
import { ArrowRightIcon } from '@heroicons/vue/24/outline';
import { TreasuryTab, useTreasuryController } from '../stores/controller.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import numeral from '../../lib/numeral.ts';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const controller = useTreasuryController();

const isLoaded = Vue.ref(false);
const currencyIsLoaded = Vue.ref(false);
const bitcoinLocksIsLoaded = Vue.ref(false);

const totalBitcoinDebt = Vue.ref(0n);
const closestMaturityDays = Vue.ref(365);

const allLocks = Vue.computed(() => {
  return bitcoinLocks.getAllLocks();
});

const nonReleasedLocks = Vue.computed(() => {
  return allLocks.value.filter(l => l.status !== BitcoinLockStatus.Released);
});

const sortedLocks = Vue.computed(() => {
  const locks = [...nonReleasedLocks.value].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  if (locks[0]) {
    const date = dayjs.utc(locks[0].createdAt);
    closestMaturityDays.value = Math.max(dayjs.utc().diff(date, 'day'), 0);
  }

  return locks;
});

function updateTotalBitcoinDebt() {
  const rates = nonReleasedLocks.value.map(lock => {
    return (
      BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, lock.satoshis, lock.lockedTargetPrice) ||
      0n
    );
  });
  totalBitcoinDebt.value = rates.reduce((sum, r) => sum + r, 0n);
}

Vue.watch([nonReleasedLocks, isLoaded], () => {
  updateTotalBitcoinDebt();
});

Vue.onMounted(async () => {
  currency.isLoadedPromise.then(() => (currencyIsLoaded.value = true));
  await bitcoinLocks.load();
  bitcoinLocksIsLoaded.value = true;

  updateTotalBitcoinDebt();
  isLoaded.value = true;
});
</script>

<style scoped>
@reference "../../main.css";

td {
  @apply border-t border-slate-400/50 py-2;
}
</style>
