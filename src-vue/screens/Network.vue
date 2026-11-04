<!-- prettier-ignore -->
<template>
  <div class="flex h-full grow flex-col justify-stretch pr-2.5">
    <section box class="grow flex flex-col p-3  overflow-y-scroll">

      <div StatWrapper class="w-full flex flex-col h-full border-b border-slate-400/50">
        <span>${{ data.totalMarketValueUsd !== undefined ? numeral(data.totalMarketValueUsd).format('0,0') : '---' }}</span>
        <label>Current Global Market Value of Network</label>
      </div>

      <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 w-full grow gap-2 divide-x divide-slate-500/30">

        <div StatWrapper class="col-span-1 xl:col-span-2 flex flex-col h-full border-b border-slate-400/50">
          <Returns metric="APY" :returns="{ apy: data.miningAPY }" :showLabel="false" />
          <label v-if="miningStats.isUpdating || (miningStats.averageAPY === undefined && data.miningAPY !== undefined)" class="whitespace-nowrap">
            Calculating Mining APY<template v-if="miningStats.cohortProgress.total > 0"> ({{ miningStats.cohortProgress.completed }}/{{ miningStats.cohortProgress.total }})</template>
          </label>
          <label v-else>Mining APY</label>
          <p v-if="!miningStats.isUpdating && miningStats.error" class="mt-2 text-sm font-light">
            Calculation interrupted.
            <button class="cursor-pointer underline" @click="retryMiningReturns">Retry</button>
          </p>
        </div>

        <div StatWrapper class="col-span-1 xl:col-span-2 flex flex-col h-full border-b border-slate-400/50">
          <Returns metric="APR" :returns="{ apr: data.vaultingAPR }" :showLabel="false" />
          <label>Vaulting APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span class="relative">
              ${{ data.usdTargetForArgon !== undefined ? numeral(data.usdTargetForArgon).format('0,0.00') : '---.--' }}
            </span>
          <label>Price Per Argon</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>${{ data.usdForArgonot !== undefined ? numeral(data.usdForArgonot).format('0,0.00') : '---.--' }}</span>
          <label>Price Per Argonot</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <Returns metric="APR" :returns="{ apr: data.bitcoinAPR }" :showLabel="false" />
          <label>Bitcoin Liquid APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <Returns metric="APR" :returns="{ apr: data.argonBondsAPR }" :showLabel="false" />
          <label>Argon Bond APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <Returns metric="APR" :returns="{ apr: data.argonotStakingAPR }" :showLabel="false" />
          <label>Argonot Staking APR</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ microgonsInCirculation !== undefined ? microgonToArgonNm(microgonsInCirculation).format('0,0') : '---' }}</span>
          <label>Argons In Circulation</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ micronotsInCirculation !== undefined ? micronotToArgonotNm(micronotsInCirculation).format('0,0') : '---'}}</span>
          <label>Argonots In Circulation</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.restabilizationLeverage ?? '---' }} <span class="text-xl font-semibold lg:text-2xl">TO</span> {{ data.restabilizationLeverage !== undefined ? '1' : '--'}}</span>
          <label>Restabilization <span class="hidden md:inline">Capacity</span></label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>
            ${{ data.mining.activeBidCostsUsd !== undefined ? numeral(data.mining.activeBidCostsUsd).format('0,0.00') : '---' }}
          </span>
          <label>Mining Expenses</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>
            ${{
              data.mining.activeBlockRewardsUsd !== undefined ? numeral(data.mining.activeBlockRewardsUsd).format('0,0.00') : '---'
            }}
          </span>
          <label class="whitespace-nowrap">
            Mining Revenue<template v-if="miningStats.cohortProgress.total > 0 && (miningStats.isUpdating || (miningStats.averageAPY === undefined && data.miningAPY !== undefined))"> ({{ miningStats.cohortProgress.completed }}/{{ miningStats.cohortProgress.total }})</template>
          </label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.vaulting.bitcoinLocked !== undefined ? numeral(data.vaulting.bitcoinLocked).format('0,0.[00000]') : '---' }}</span>
          <label>Bitcoin In Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span class="block md:hidden">${{ data.usdForBtc !== undefined ? numeral(data.usdForBtc).format('0,0') : '---'}}</span>
          <span class="hidden md:block">${{ data.usdForBtc !== undefined ? numeral(data.usdForBtc).formatIfElse('<1_000', '0,0.00', '0,0') : '---.--'}}</span>
          <label>Price Per Bitcoin</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              {{ currentBlockNumber !== undefined ? numeral(currentBlockNumber).format('0,0') : '---' }}
            </span>
          <label>Mined Blocks</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.vaulting.count !== undefined ? data.vaulting.count : '---' }}</span>
          <label>Active Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
            <span>
              ${{ data.vaulting.valueInVaults !== undefined ? numeral(data.vaulting.valueInVaults).format('0,0.00') : '---' }}
            </span>
          <label>Total Value In Vaults</label>
        </div>

        <div StatWrapper class="flex flex-col h-full border-b border-slate-400/50">
          <span>{{ data.mining.activeSeatCount ?? '---' }}</span>
          <label>Active Mining Seats</label>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import Returns from '../components/Returns.vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { calculateRestabilizationLeverage } from '@argonprotocol/apps-core';
import { getCurrency } from '../stores/currency.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { useMiningStats } from '../stores/miningStats.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { getVaults } from '../stores/vaults.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';

dayjs.extend(utc);

const miningStats = useMiningStats();
const vaultingStats = useVaultingStats();
const currency = getCurrency();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const currentBlockNumber = Vue.ref<number>();
const microgonsInCirculation = Vue.ref<bigint>();
const micronotsInCirculation = Vue.ref<bigint>();

const data = Vue.computed(() => {
  const microgonValueOfArgonots = currency.convertMicronotTo(
    micronotsInCirculation.value ?? 0n,
    UnitOfMeasurement.Microgon,
  );
  const totalEconomicValue = (microgonsInCirculation.value ?? 0n) + microgonValueOfArgonots;
  const restabilizationLeverage = calculateRestabilizationLeverage({
    argonBurnCapacity: vaultingStats.argonBurnCapacity,
    microgonsInCirculation: microgonsInCirculation.value ?? 0n,
  });
  const miningRevenue =
    miningStats.averageAPY !== undefined
      ? miningStats.activeBlockRewards
      : miningStats.provisionalReturns?.microgonRevenue;

  return {
    totalMarketValueUsd:
      currency.isLoaded && microgonsInCirculation.value !== undefined && micronotsInCirculation.value !== undefined
        ? currency.convertMicrogonTo(totalEconomicValue, UnitOfMeasurement.USD)
        : undefined,
    miningAPY: miningStats.averageAPY ?? miningStats.provisionalReturns?.apy,
    vaultingAPR: vaultingStats.isLoaded ? vaultingStats.averageAPR : undefined,
    bitcoinAPR: vaultingStats.bitcoinAPR,
    argonBondsAPR: vaultingStats.argonBondsAPR,
    argonotStakingAPR: vaultingStats.isLoaded ? vaultingStats.argonotStakingAPR : undefined,
    usdTargetForArgon: currency.isLoaded ? currency.priceIndex.argonUsdTargetPrice?.toNumber() : undefined,
    usdForArgonot: currency.isLoaded ? currency.priceIndex.argonotUsdPrice?.toNumber() : undefined,
    usdForBtc: currency.isLoaded ? currency.priceIndex.btcUsdPrice?.toNumber() : undefined,
    restabilizationLeverage:
      vaultingStats.isLoaded && microgonsInCirculation.value !== undefined ? restabilizationLeverage : undefined,
    mining: {
      activeSeatCount: miningStats.hasCurrentStats ? miningStats.activeMiningSeatCount : undefined,
      activeBidCostsUsd:
        currency.isLoaded && miningStats.hasCurrentStats
          ? currency.convertMicrogonTo(miningStats.activeBidCosts, UnitOfMeasurement.USD)
          : undefined,
      activeBlockRewardsUsd:
        currency.isLoaded && miningRevenue !== undefined
          ? currency.convertMicrogonTo(miningRevenue, UnitOfMeasurement.USD)
          : undefined,
    },
    vaulting: {
      count: vaultingStats.isLoaded ? vaultingStats.vaultCount : undefined,
      valueInVaults:
        currency.isLoaded && vaultingStats.isLoaded
          ? currency.convertMicrogonTo(vaultingStats.microgonValueInVaults, UnitOfMeasurement.USD)
          : undefined,
      bitcoinLocked: vaultingStats.isLoaded ? vaultingStats.bitcoinLocked : undefined,
    },
  };
});

async function retryMiningReturns() {
  await miningStats.update().catch(error => console.warn('[Network] Unable to refresh mining statistics', error));
}

async function loadData() {
  void miningStats.update().catch(error => console.warn('[Network] Unable to refresh mining statistics', error));
  void vaultingStats
    .update()
    .then(() => getVaults().updateRevenue())
    .then(() => vaultingStats.update())
    .catch(error => console.warn('[Network] Unable to refresh vaulting statistics', error));

  try {
    await currency.load();
    const client = await getMainchainClient(false);
    const [blockNumber, microgons, micronots] = await Promise.all([
      client.query.system.number(),
      currency.fetchMicrogonsInCirculation(client),
      currency.fetchMicronotsInCirculation(),
    ]);

    currentBlockNumber.value = blockNumber;
    microgonsInCirculation.value = microgons;
    micronotsInCirculation.value = micronots;
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
