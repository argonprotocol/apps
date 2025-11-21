import * as Vue from 'vue';
import { useVaults } from './vaults.ts';
import { SATOSHIS_PER_BITCOIN } from '../lib/Currency.ts';
import { defineStore } from 'pinia';
import { getMining } from './mainchain.ts';
import { useCurrency } from './currency.ts';
import { calculateAPY } from '../lib/Utils.ts';

export const useMiningStats = defineStore('miningStats', () => {
  const currency = useCurrency();

  const activeMiningSeatCount = Vue.ref(0);
  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref(0n);

  const currentAPY = Vue.computed(() => {
    return calculateAPY(aggregatedBidCosts.value, aggregatedBlockRewards.value);
  });

  async function updateActiveMiningSeatCount() {
    const mainchain = getMining();
    activeMiningSeatCount.value = await mainchain.getActiveMinersCount();
  }

  async function updateAggregateBidCosts() {
    aggregatedBidCosts.value = await getMining().getAggregateBidCosts();
  }

  async function updateAggregateBlockRewards() {
    const blockRewards = await getMining().getAggregateBlockRewards();
    aggregatedBlockRewards.value = blockRewards.microgons + currency.micronotToMicrogon(blockRewards.micronots);
  }

  async function load() {
    await Promise.all([updateActiveMiningSeatCount(), updateAggregateBidCosts(), updateAggregateBlockRewards()]);
  }

  const isLoadedPromise = load();

  return {
    isLoadedPromise,
    aggregatedBidCosts,
    activeMiningSeatCount,
    aggregatedBlockRewards,
    currentAPY,
    updateAggregateBidCosts,
    updateAggregateBlockRewards,
    updateActiveMiningSeatCount,
  };
});
