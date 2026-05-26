<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col">
    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">Loading...</div>

    <!-- Blank state -->
    <div v-else-if="!financials.liquidAllRecords.length" class="flex grow flex-col">
      <div class="grow flex flex-col items-center justify-center">
        <div class="flex flex-col items-center w-8/12 max-w-200 py-10">
          <header class="font-bold text-argon-600 text-xl pb-3">Argon Offers Network-Backed Loans That Are Free From Interest</header>
          <p class="w-0 min-w-full border-y border-slate-400/50 py-4 text-[17px]/7 font-light whitespace-normal">
            Argon Network provides interest-free loans to all bitcoin holders up to the full market value of their
            bitcoin. These loans are for a duration of one year, after which you can continue to extend it for additional
            years. The stablecoins you receive are unencumbered, meaning you have the full freedom to deploy your capital
            however you want.
          </p>
          <div class=" mt-12">
            <button @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)" class="text-argon-600 font-bold cursor-pointer border border-argon-600 px-12 py-3 text-lg rounded-md hover:bg-argon-600/5">
              Open Bitcoin Locks Tab
              <ArrowRightIcon class="w-5 h-5 inline-block ml-1" />
            </button>
          </div>
        </div>
      </div>
      <div class="relative pb-1 pl-0.5 pr-1">
        <img src="/treasury-footers/interest-free-liabilities.png" class="w-full opacity-80" />
      </div>
    </div>

    <div v-else class="min-h-0 grow flex flex-col">
      <section class="mt-5 flex flex-row items-end gap-x-2 text-center px-9">
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="inline-flex text-argon-600 text-5xl font-bold">
            <span>{{ currency.symbol }}</span>
            <FormattedMoney :value="financials.liquidCurrentBitcoinDebt" />
          </div>
          <div class="font-light text-slate-900/70">Outstanding Debt</div>
        </div>
        <div class="relative h-full w-px bg-slate-400/30"/>
        <div class="w-1/3 border-b border-slate-400/30 py-5">
          <div class="text-argon-600 text-5xl font-bold">
            {{ financials.liquidVisibleRecords.length }}
          </div>
          <div class="font-light text-slate-900/70">
            Active Position{{ financials.liquidVisibleRecords.length === 1 ? '' : 's' }}
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

      <div class="relative flex min-h-0 grow flex-col">
        <div class="flex flex-col overflow-y-auto px-9 pt-10 pb-5">
          <div class="flex flex-row items-center text-slate-800/70">
            <span class="grow">
              You have {{ financials.liquidVisibleRecords.length }} outstanding loan{{
                financials.liquidVisibleRecords.length === 1 ? '' : 's'
              }}...
            </span>
            <div class="flex flex-row gap-x-3 items-stretch">
              <a
                href="https://argon.network/"
                class="text-md text-argon-600 cursor-pointer"
              >
                View Docs
              </a>
            </div>
          </div>
        </div>

        <section class="flex flex-col gap-y-3 px-9">
          <DebtRecord
            v-for="lockSummary in financials.liquidLockedRecords"
            :key="lockSummary.uuid ?? lockSummary.utxoId"
            :lockSummary="lockSummary"
          />
        </section>
      </div>
      <div class="absolute top-0 left-0 h-10 w-full bg-linear-to-b from-white to-transparent" />

      <div class="relative pb-1 pl-0.5 pr-1">
        <img src="/treasury-footers/interest-free-liabilities.png" class="w-full opacity-80" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import LoanIcon from '../../assets/loan.svg';
import { ArrowRightIcon } from '@heroicons/vue/24/outline';
import { TreasuryTab, useTreasuryController } from '../stores/controller.ts';
import DebtRecord from './components/DebtRecord.vue';
import { useFinancials } from '../stores/financials.ts';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const controller = useTreasuryController();
const financials = useFinancials();

const isLoaded = Vue.ref(false);
const currencyIsLoaded = Vue.ref(false);

const closestMaturityDays = Vue.computed(() => {
  const nextMaturityMillis = financials.liquidVisibleRecords.reduce<number | undefined>((closest, lockSummary) => {
    const maturityMillis = bitcoinLocks.unlockDeadlineTime(lockSummary.record);
    return closest === undefined || maturityMillis < closest ? maturityMillis : closest;
  }, undefined);

  if (nextMaturityMillis === undefined) {
    return 0;
  }

  return Math.max(dayjs.utc(nextMaturityMillis).diff(dayjs.utc(), 'day'), 0);
});

Vue.onMounted(async () => {
  currency.isLoadedPromise.then(() => (currencyIsLoaded.value = true));
  await bitcoinLocks.load();

  isLoaded.value = true;
});
</script>

<style scoped>
@reference "../../main.css";

td {
  @apply border-t border-slate-400/50 py-2;
}
</style>
