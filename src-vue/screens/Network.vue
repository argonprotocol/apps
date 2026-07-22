<!-- prettier-ignore -->
<template>
  <div class="flex h-full grow flex-col justify-stretch pr-2.5">
    <section box class="grow flex flex-col p-3  overflow-y-scroll">

      <div StatWrapper class="w-full flex flex-col h-full border-b border-slate-400/50">
        <span>${{ data.totalMarketValueUsd ? numeral(data.totalMarketValueUsd).format('0,0') : '---' }}</span>
        <label>Current Global Market Value of Network</label>
      </div>

      <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 w-full grow gap-2 divide-x divide-slate-500/30">

        <div StatWrapper class="col-span-1 xl:col-span-2 flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.miningAPR ? numeral(data.miningAPR).formatCapped('0,0.[0]', 9_999) : '---' }}%</span>
          <label>Current Mining APR</label>
        </div>

        <div StatWrapper class="col-span-1 xl:col-span-2 flex flex-col h-full border-b border-slate-400/50">
            <span>
              {{ data.vaultingAPR ? numeral(data.vaultingAPR).formatIfElseCapped('< 1_000', '0,0.[0]', '0,0', 9_999) : '0' }}%
            </span>
          <label>Current Vaulting APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span class="relative">
              ${{ data.usdTargetForArgon ? numeral(data.usdTargetForArgon).format('0,0.00') : '---.--' }}
            </span>
          <label>Price Per Argon</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>${{ data.usdForArgonot ? numeral(data.usdForArgonot).format('0,0.00') : '---.--' }}</span>
          <label>Price Per Argonot</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              {{ data.bitcoinAPR ? numeral(data.bitcoinAPR).formatIfElseCapped('< 1_000', '0,0.[0]', '0,0', 9_999) : '---' }}%
            </span>
          <label>Current Locked Bitcoin APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              {{ data.bondsAPR ? numeral(data.bondsAPR).formatIfElseCapped('< 1_000', '0,0.[0]', '0,0', 9_999) : '---' }}%
            </span>
          <label>Current Treasury Bond APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ microgonsInCirculation ? microgonToArgonNm(microgonsInCirculation).format('0,0') : '---' }}</span>
          <label>Argons In Circulation</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ micronotsInCirculation ? micronotToArgonotNm(micronotsInCirculation).format('0,0') : '---'}}</span>
          <label>Argonots In Circulation</label>
        </div>

        <div StatWrapper class="col-span-1 sm:col-span-2 flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.restabilizationLeverage || '---' }} <span class="text-xl font-semibold lg:text-2xl">TO</span> {{ data.restabilizationLeverage ? '1' : '--'}}</span>
          <label>Argon Restabilization <span class="hidden md:inline">Capacity</span></label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              ${{ data.mining.activeBidCostsUsd ? numeral(data.mining.activeBidCostsUsd).format('0,0.00') : '---' }}
            </span>
          <label>Cost of Mining Seats</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              ${{
                data.mining.activeBlockRewardsUsd ? numeral(data.mining.activeBlockRewardsUsd).format('0,0.00') : '---'
              }}
            </span>
          <label>Revenue from Mining Seats</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.vaulting.bitcoinLocked ? numeral(data.vaulting.bitcoinLocked).format('0,0.[00000]') : '---' }}</span>
          <label>Bitcoin In Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span class="block md:hidden">${{ numeral(data.usdForBtc).format('0,0')}}</span>
          <span class="hidden md:block">${{ numeral(data.usdForBtc).format('0,0.00')}}</span>
          <label>Price Per Bitcoin</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              {{ currentBlockNumber ? numeral(currentBlockNumber).format('0,0') : '---' }}
            </span>
          <label>Mined Blocks</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.vaulting.count ? data.vaulting.count : '---' }}</span>
          <label>Active Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              ${{ data.vaulting.valueInVaults ? numeral(data.vaulting.valueInVaults).format('0,0.00') : '---' }}
            </span>
          <label>Total Value In Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.mining.activeSeatCount || '---' }}</span>
          <label>Active Mining Seats</label>
        </div>
      </div>

      <BlankSlateBlocks />

    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import {
  BitcoinPrices,
  calculateBitcoinRatchetReturn,
  calculateRestabilizationLeverage,
} from '@argonprotocol/apps-core';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { getVaults } from '../stores/vaults.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';
import BlankSlateBlocks from './network-screen/BlankSlateBlocks.vue';

dayjs.extend(utc);

const miningStats = useMiningStats();
const vaultingStats = useVaultingStats();
const currency = getCurrency();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const currentBlockNumber = Vue.ref(0);
const microgonsInCirculation = Vue.ref(0n);
const micronotsInCirculation = Vue.ref(0n);
const bitcoinPrices = new BitcoinPrices().getDateRange(
  dayjs.utc().subtract(1, 'year').format('YYYY-MM-DD'),
  dayjs.utc().format('YYYY-MM-DD'),
);
const bitcoinAPR = calculateBitcoinRatchetReturn({
  prices: bitcoinPrices,
  flatFee: 2,
  percentageFee: 5,
  ratchetThreshold: 0.1,
}).percent;

const data = Vue.computed(() => {
  const microgonValueOfArgonots = currency.convertMicronotTo(micronotsInCirculation.value, UnitOfMeasurement.Microgon);
  const totalEconomicValue = microgonsInCirculation.value + microgonValueOfArgonots;
  const restabilizationLeverage = calculateRestabilizationLeverage({
    argonBurnCapacity: vaultingStats.argonBurnCapacity,
    microgonsInCirculation: microgonsInCirculation.value,
  });

  return {
    totalMarketValueUsd: currency.isLoaded ? currency.convertMicrogonTo(totalEconomicValue, UnitOfMeasurement.USD) : 0,
    miningAPR: miningStats.averageAPR,
    vaultingAPR: vaultingStats.averageAPR,
    bitcoinAPR,
    bondsAPR: vaultingStats.bondsAPR,
    usdTargetForArgon: currency.priceIndex.argonUsdTargetPrice?.toNumber() ?? 0,
    usdForArgonot: currency.priceIndex.argonotUsdPrice?.toNumber() ?? 0,
    usdForBtc: currency.priceIndex.btcUsdPrice?.toNumber() ?? 0,
    restabilizationLeverage,
    mining: {
      activeSeatCount: miningStats.activeMiningSeatCount,
      activeBidCostsUsd: currency.isLoaded
        ? currency.convertMicrogonTo(miningStats.activeBidCosts, UnitOfMeasurement.USD)
        : 0,
      activeBlockRewardsUsd: currency.isLoaded
        ? currency.convertMicrogonTo(miningStats.activeBlockRewards, UnitOfMeasurement.USD)
        : 0,
    },
    vaulting: {
      count: vaultingStats.vaultCount,
      valueInVaults: currency.isLoaded
        ? currency.convertMicrogonTo(vaultingStats.microgonValueInVaults, UnitOfMeasurement.USD)
        : 0,
      bitcoinLocked: vaultingStats.bitcoinLocked,
    },
  };
});

async function loadData() {
  try {
    await currency.load();
    const client = await getMainchainClient(false);
    const [blockNumber, microgons, micronots] = await Promise.all([
      client.query.system.number(),
      currency.fetchMicrogonsInCirculation(client),
      currency.fetchMicronotsInCirculation(),
      miningStats.update(),
      vaultingStats.update(),
    ]);

    currentBlockNumber.value = blockNumber.toNumber();
    microgonsInCirculation.value = microgons;
    micronotsInCirculation.value = micronots;

    void getVaults()
      .updateRevenue()
      .then(() => vaultingStats.update())
      .catch(error => console.warn('[Network] Unable to refresh vault revenue statistics', error));
  } catch (error) {
    console.error('[Network] Unable to load live network statistics', error);
  }
}

Vue.onMounted(loadData);
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply h-full rounded border-[1px] border-slate-400/30 bg-white shadow;
}

[StatWrapper] {
  @apply flex min-w-0 flex-col items-center justify-center px-3 py-6 text-slate-800/70 sm:py-8 lg:py-10 xl:py-12;
  /* rounded border border-slate-500/20 bg-white/90 shadow-md */

  & > span {
    @apply max-w-full text-center text-3xl leading-none font-bold break-words sm:text-4xl;
  }

  label {
    @apply mt-2 px-2 text-center text-sm leading-snug font-light sm:text-base;
  }
}
</style>
