<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col">
    <div class="relative flex grow flex-row mx-6 lg:mx-20 mt-10">
      <div class="flex flex-col w-[25%] pt-5">
        <div @click="changeTab(PortfolioTab.AssetBreakdown)" class="cursor-pointer">
          <div class="flex flex-row relative items-center text-xl font-bold text-slate-800/80">
            <div class="mr-2">Mining</div>
            <div class="grow h-[3px] bg-slate-300" />
            <div class="absolute top-1/2 -translate-y-1/2 left-full h-[3px] bg-slate-300 w-1/2" />
          </div>
          <div class="text-lg text-slate-700/50 mt-1">
            {{ currency.symbol }}{{ microgonToMoneyNm(wallets.totalMiningResources).format('0,0.00') }}
            <span class="font-light">({{ numeral(miningPct).format('0.[00]') }}%)</span>
          </div>
        </div>
        <ul class="grow flex flex-col mt-7 text-slate-900/70">
          <li class="h-px w-full relative">
            <div class="absolute top-0 left-0 w-[140%] h-px bg-gradient-to-r from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningMoveInstantaneously).format('0,0.00') }} can move<br />
            instantaneously
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 left-0 w-[120%] h-px bg-gradient-to-r from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningMoveWithin24Hours).format('0,0.00') }} is locked<br />
            for at least 24 hours
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 left-0 w-[130%] h-px bg-gradient-to-r from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningMoveWithin10Days).format('0,0.00') }} is locked<br />
            for up to ten days
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 left-0 w-[140%] h-px bg-gradient-to-r from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col font-bold justify-center text-argon-600">
            <div @click="changeTab(PortfolioTab.AssetBreakdown)" class="-translate-y-1/2 cursor-pointer">View Mining Assets</div>
          </li>
        </ul>
      </div>
      <div class="relative flex flex-row h-full w-[50%] justify-center z-10">
        <TwoSlicePie
          :data="data"
          :rotation="rotation"
          :animate="shouldAnimateChart"
          class="absolute -top-[15px] w-[calc(100%+30px)] left-1/2 -translate-x-1/2 flex flex-row h-[calc(110%+30px)]! justify-center"
        />
      </div>
      <div class="flex flex-col w-[25%] pt-5 text-right">
        <div @click="changeTab(PortfolioTab.AssetBreakdown)" class="cursor-pointer">
          <div class="flex flex-row relative items-center text-xl font-bold text-slate-800/80">
            <div class="absolute top-1/2 -translate-y-1/2 right-full h-[3px] bg-slate-300 w-1/2" />
            <div class="grow h-[3px] bg-slate-300" />
            <div class="ml-2">Vaulting</div>
          </div>
          <div class="text-lg text-slate-700/50 mt-1">
            <span class="font-light">({{ numeral(vaultingPct).format('0.[00]') }}%)</span>
            {{ currency.symbol }}{{ microgonToMoneyNm(wallets.totalVaultingResources).format('0,0.00') }}
          </div>
        </div>
        <ul class="grow flex flex-col mt-7 text-slate-900/70">
          <li class="h-px w-full relative">
            <div class="absolute top-0 right-0 w-[140%] h-px bg-gradient-to-l from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingMoveInstantaneously).format('0,0.00') }} can move<br />
            instantaneously
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 right-0 w-[120%] h-px bg-gradient-to-l from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingMoveWithin24Hours).format('0,0.00') }} is locked for<br />
            at least 24 hours
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 right-0 w-[130%] h-px bg-gradient-to-l from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col justify-center">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingMoveWithin1Year).format('0,0.00') }} is locked<br />
            for up to one year
          </li>
          <li class="h-px w-full relative">
            <div class="absolute top-0 right-0 w-[140%] h-px bg-gradient-to-l from-[50%] from-argon-300/20 to-transparent" />
          </li>
          <li class="h-1/4 flex flex-col font-bold justify-center text-argon-600">
            <div @click="changeTab(PortfolioTab.AssetBreakdown)" class="-translate-y-1/2 cursor-pointer">View Vaulting Assets</div>
          </li>
        </ul>
      </div>
    </div>
    <section class="mx-2 flex flex-row gap-x-2 text-center mt-5 mb-2 border-t border-argon-300/30">
      <div StatWrapper class="w-1/3">
        <div Stat>{{ numeral(portfolio.originalCapitalRoi).format('0,0.[00]') }}%</div>
        <label>ROI To-Date</label>
      </div>
      <div class="w-px h-full bg-argon-300/30" />
      <div StatWrapper class="w-1/3">
        <div Stat>{{ currency.symbol }}{{ microgonToMoneyNm(wallets.totalNetWorth).format('0,0.00') }}</div>
        <label>Total Value</label>
      </div>
      <div class="w-px h-full bg-argon-300/30" />
      <div StatWrapper class="w-1/3">
        <div Stat>{{ numeral(portfolio.projectedApy).formatIfElseCapped('< 1000', '0,0.0[0]', '0,0', 9_999) }}%</div>
        <label>Projected APY</label>
      </div>
    </section>
    <div
      @click="changeTab(PortfolioTab.TransactionHistory)"
      class="flex h-34 mx-2 cursor-pointer flex-col pt-10 text-center text-slate-900/60 border-t border-argon-300/30"
    >
      <template v-if="lastTx">
        <div class="font-bold">Last Transaction Was {{ dayjs.utc(lastTx.createdAt).local().fromNow() }}</div>
        <div class="mt-2">
          {{ microgonToArgonNm(bigIntAbs(lastTx.amount)).format('0,0.[00]') }}
          {{ lastTx.currency === 'argon' ? 'ARGN' : 'ARGNOT' }}
          from
          {{ getTransferInfo(lastTx) }}
        </div>
      </template>
      <template v-else>
        <div class="font-bold">Last Transaction</div>
        <div class="mt-2 font-light italic opacity-50">
          This Account Has Zero Transactions
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import * as Vue from 'vue';

const shouldAnimateChart = Vue.ref(true);
</script>

<script setup lang="ts">
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import BigNumber from 'bignumber.js';
import TwoSlicePie from '../../components/TwoSlicePie.vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { usePortfolio } from '../../stores/portfolio.ts';
import { getWalletBalances, useWallets } from '../../stores/wallets.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import { IWalletTransferRecord } from '../../lib/db/WalletTransfersTable.ts';
import { bigIntAbs, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';
import { getTransferInfo } from './TransactionHistory.vue';
import { PortfolioTab } from '../interfaces/IPortfolioTab.ts';

dayjs.extend(utc);

const portfolio = usePortfolio();
const wallets = useWallets();
const vaultingAssets = useVaultingAssetBreakdown();
const miningAssets = useMiningAssetBreakdown();
const currency = getCurrency();

const emit = defineEmits<{
  (e: 'changeTab', tab: PortfolioTab): void;
}>();

const { microgonToMoneyNm, microgonToArgonNm } = createNumeralHelpers(currency);

const miningPct = Vue.computed(() => {
  if (!wallets.totalNetWorth) return 0;
  return BigNumber(wallets.totalMiningResources).div(wallets.totalNetWorth).toNumber() * 100;
});

const vaultingPct = Vue.computed(() => {
  if (!wallets.totalNetWorth) return 0;
  return BigNumber(wallets.totalVaultingResources).div(wallets.totalNetWorth).toNumber() * 100;
});

const rotation = Vue.computed(() => {
  if (!vaultingPct.value && !miningPct.value) {
    return 0;
  } else if (vaultingPct.value >= 84) {
    const diff = 16 - (100 - vaultingPct.value);
    return -(diff * 2);
  } else if (vaultingPct.value >= 16) {
    return 0;
  }
  return 32 - vaultingPct.value * 1.6;
});

const miningMoveInstantaneously = Vue.computed(() => {
  const valueOfMicrogons = miningAssets.auctionMicrogonsUnused;
  const valueOfMicronots = currency.convertMicronotTo(miningAssets.auctionMicronotsUnused, UnitOfMeasurement.Microgon);
  const valueOfAuctionUnused = valueOfMicrogons + valueOfMicronots;
  return miningAssets.sidelinedTotalValue + valueOfAuctionUnused;
});

const miningMoveWithin24Hours = Vue.computed(() => {
  const valueOfMicrogons = miningAssets.auctionMicrogonsActivated;
  const valueOfMicronots = currency.convertMicronotTo(
    miningAssets.auctionMicronotsActivated,
    UnitOfMeasurement.Microgon,
  );
  return valueOfMicrogons + valueOfMicronots;
});

const miningMoveWithin10Days = Vue.computed(() => {
  return miningAssets.expectedSeatValue;
});

const vaultingMoveInstantaneously = Vue.computed(() => {
  const valueOfMicrogons = vaultingAssets.securityMicrogonsUnused;
  const valueOfMicronots = currency.convertMicronotTo(
    vaultingAssets.securityMicronotsUnused,
    UnitOfMeasurement.Microgon,
  );
  const valueOfSecurityUnused = valueOfMicrogons + valueOfMicronots;
  return vaultingAssets.sidelinedTotalValue + valueOfSecurityUnused;
});

const vaultingMoveWithin24Hours = Vue.computed(() => {
  const valueOfMicrogons = vaultingAssets.securityMicrogonsPending;
  const valueOfMicronots = currency.convertMicronotTo(
    vaultingAssets.securityMicronotsPending,
    UnitOfMeasurement.Microgon,
  );
  return valueOfMicrogons + valueOfMicronots;
});

const vaultingMoveWithin1Year = Vue.computed(() => {
  return vaultingAssets.securityMicrogonsActivated;
});

const data: [any, any] = [
  { label: 'Mining', value: miningPct.value || 0.1, color: '#DF8DDC' },
  { label: 'Vaulting', value: vaultingPct.value || 0.1, color: '#982289' },
];

const transactions = Vue.ref<IWalletTransferRecord[]>([]);

const lastTx = Vue.computed(() => {
  return transactions.value[0];
});

function changeTab(tab: PortfolioTab) {
  emit('changeTab', tab);
}

async function loadTransactionHistory(): Promise<void> {
  const db = await getDbPromise();

  const allTransfers = await db.walletTransfersTable.fetchAll();
  const allBlockExtrinsics: { [key: string]: number } = {};
  for (const tx of allTransfers) {
    const key = `${tx.blockNumber}-${tx.extrinsicIndex}`;
    allBlockExtrinsics[key] ??= 0;
    allBlockExtrinsics[key] += 1;
  }
  transactions.value = allTransfers.filter(x => {
    return !(x.amount < 0n && allBlockExtrinsics[`${x.blockNumber}-${x.extrinsicIndex}`] > 1);
  });
}

Vue.onMounted(async () => {
  await loadTransactionHistory();
  const balances = getWalletBalances();
  balances.events.on('transfer-in', async () => {
    await loadTransactionHistory();
  });

  setTimeout(() => {
    shouldAnimateChart.value = false;
  }, 1e3);
});
</script>

<style scoped>
@reference "../../main.css";

[StatWrapper] {
  @apply flex flex-col justify-center gap-y-1 rounded-lg pt-20 pb-10;
  [Stat] {
    @apply font-mono text-2xl font-extrabold text-slate-800/80;
  }
  label {
    @apply -mt-1 text-sm font-medium text-slate-700/50;
  }
}
</style>
