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

  const activeBidCosts = Vue.ref(0n);
  const activeBlockRewards = Vue.ref(0n);
  const activeAPY = Vue.ref(0);

  async function update() {
    if (!isLoading && !isLoadedPromise) await stats.load();
    else if (!isLoading) await stats.update();
    isLoading = true;

    activeMiningSeatCount.value = stats.activeSeatCount;
    aggregatedBidCosts.value = stats.aggregatedBidCosts;
    aggregatedBlockRewards.value = stats.aggregatedBlockRewards;

    activeBidCosts.value = stats.activeBidCosts;
    activeBlockRewards.value = stats.activeBlockRewards;
    activeAPY.value = calculateAPY(stats.activeBidCosts, stats.activeBlockRewards);
    isLoading = false;
  }

  isLoadedPromise = update();

  return {
    isLoadedPromise,
    aggregatedBidCosts,
    activeMiningSeatCount,
    aggregatedBlockRewards,
    activeBidCosts,
    activeBlockRewards,
    activeAPY,
    update,
  };
});
