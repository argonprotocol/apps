import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getBlockWatch, getMining } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { GlobalMiningStats } from '@argonprotocol/apps-core';

export const useMiningStats = defineStore('miningStats', () => {
  let hasLoaded = false;
  let updatePromise: Promise<void> | undefined = undefined;
  let isLoadedPromise: Promise<void> | undefined = undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempts = 0;
  let isDisposed = false;

  const mining = getMining();
  const currency = getCurrency();
  const stats = new GlobalMiningStats(mining, currency);

  const hasCurrentStats = Vue.ref(false);
  const isUpdating = Vue.ref(false);
  const error = Vue.ref('');
  const cohortProgress = Vue.shallowRef(stats.cohortProgress);
  const provisionalReturns = Vue.shallowRef(stats.provisionalReturns);

  const activeMiningSeatCount = Vue.ref(0);

  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref(0n);
  const investedCapital = Vue.ref(0n);
  const projectedProfit = Vue.ref(0n);

  const activeBidCosts = Vue.ref(0n);
  const activeBlockRewards = Vue.ref(0n);
  const averageAPR = Vue.ref<number>();
  const averageAPY = Vue.ref<number>();

  async function update() {
    if (updatePromise) return await updatePromise;

    clearTimeout(retryTimer);
    retryTimer = undefined;
    isUpdating.value = true;
    error.value = '';
    cohortProgress.value = { completed: 0, total: 0 };

    updatePromise = (async () => {
      const publishProgress = () => {
        if (isDisposed) return;
        hasCurrentStats.value = stats.hasCurrentStats;
        activeMiningSeatCount.value = stats.activeSeatCount;
        activeBidCosts.value = stats.activeBidCosts;
        cohortProgress.value = stats.cohortProgress;
        provisionalReturns.value = stats.provisionalReturns;
      };
      if (!hasLoaded) {
        await stats.load(publishProgress);
        hasLoaded = true;
      } else {
        await stats.update(publishProgress);
      }
      if (isDisposed) return;

      publishProgress();
      aggregatedBidCosts.value = stats.aggregatedBidCosts;
      aggregatedBlockRewards.value = stats.aggregatedBlockRewards;
      investedCapital.value = stats.investedCapital;
      projectedProfit.value = stats.projectedProfit;

      activeBlockRewards.value = stats.activeBlockRewards;
      averageAPR.value = stats.activeAPR;
      averageAPY.value = stats.activeAPY;
    })();

    try {
      await updatePromise;
      retryAttempts = 0;
    } catch (cause) {
      if (!isDisposed) error.value = 'Unable to finish calculating mining returns.';
      scheduleRetry();
      throw cause;
    } finally {
      isUpdating.value = false;
      updatePromise = undefined;
    }
  }

  function scheduleRetry() {
    if (isDisposed || retryTimer || retryAttempts >= 3) return;

    const retryDelayMs = 1_000 * 2 ** retryAttempts;
    retryAttempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void update().catch(error => console.warn('[MiningStats] Unable to refresh returns', error));
    }, retryDelayMs);
  }

  const unsubscribeFinalized = getBlockWatch().events.on('finalized', () => {
    if (retryAttempts < 3 || retryTimer || updatePromise) return;

    void update().catch(error => console.warn('[MiningStats] Unable to refresh returns', error));
  });

  Vue.onScopeDispose(() => {
    isDisposed = true;
    clearTimeout(retryTimer);
    unsubscribeFinalized();
  });

  isLoadedPromise = update();
  void isLoadedPromise.catch(error => console.warn('[MiningStats] Unable to load returns', error));

  return {
    isLoadedPromise,
    hasCurrentStats,
    isUpdating,
    error,
    cohortProgress,
    provisionalReturns,
    aggregatedBidCosts,
    activeMiningSeatCount,
    aggregatedBlockRewards,
    investedCapital,
    projectedProfit,
    activeBidCosts,
    activeBlockRewards,
    averageAPR,
    averageAPY,
    update,
  };
});
