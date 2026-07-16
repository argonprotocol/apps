import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getMining } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { GlobalMiningStats } from '@argonprotocol/apps-core';

export const useMiningStats = defineStore('miningStats', () => {
  let hasLoaded = false;
  let updatePromise: Promise<void> | undefined = undefined;
  let isLoadedPromise: Promise<void> | undefined = undefined;

  const mining = getMining();
  const currency = getCurrency();
  const stats = new GlobalMiningStats(mining, currency);

  const activeMiningSeatCount = Vue.ref(0);

  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref(0n);

  const activeBidCosts = Vue.ref(0n);
  const activeBlockRewards = Vue.ref(0n);
  const averageAPY = Vue.ref(0);

  async function update() {
    if (updatePromise) return await updatePromise;

    updatePromise = (async () => {
      if (!hasLoaded) {
        await stats.load();
        hasLoaded = true;
      } else {
        await stats.update();
      }

      activeMiningSeatCount.value = stats.activeSeatCount;
      aggregatedBidCosts.value = stats.aggregatedBidCosts;
      aggregatedBlockRewards.value = stats.aggregatedBlockRewards;

      activeBidCosts.value = stats.activeBidCosts;
      activeBlockRewards.value = stats.activeBlockRewards;
      averageAPY.value = stats.activeAPY;
    })();

    try {
      await updatePromise;
    } finally {
      updatePromise = undefined;
    }
  }

  isLoadedPromise = update();

  return {
    isLoadedPromise,
    aggregatedBidCosts,
    activeMiningSeatCount,
    aggregatedBlockRewards,
    activeBidCosts,
    activeBlockRewards,
    averageAPY,
    update,
  };
});
