import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getMining } from './mainchain.ts';
import { Currency, getCurrency } from './currency.ts';
import { calculateAPY, GlobalMiningStats, UnitOfMeasurement } from '@argonprotocol/apps-core';

export const useMiningStats = defineStore('miningStats', () => {
  let isLoading = false;
  let isLoadedPromise: Promise<void> | undefined = undefined;

  const mining = getMining();
  const currency = getCurrency();
  const stats = new GlobalMiningStats(mining, currency as Currency);

  const activeMiningSeatCount = Vue.ref(0);
  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref(0n);
  const currentAPY = Vue.ref(0);

  async function update() {
    if (!isLoading && !isLoadedPromise) await stats.load();
    else if (!isLoading) await stats.update();
    isLoading = true;

    activeMiningSeatCount.value = await mining.fetchActiveMinersCount();
    aggregatedBidCosts.value = await getMining().fetchAggregateBidCosts();

    const blockRewards = await getMining().getAggregateBlockRewards();
    const valueOfMicronots = currency.convertMicronotTo(blockRewards.micronots, UnitOfMeasurement.Microgon);
    aggregatedBlockRewards.value = blockRewards.microgons + valueOfMicronots;

    currentAPY.value = calculateAPY(aggregatedBidCosts.value, aggregatedBlockRewards.value);
    isLoading = false;
  }

  isLoadedPromise = update();

  return {
    isLoadedPromise,
    aggregatedBidCosts,
    activeMiningSeatCount,
    aggregatedBlockRewards,
    currentAPY,
    update,
  };
});
