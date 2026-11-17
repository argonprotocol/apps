import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getBlockWatch, getMining } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { GlobalMiningStats } from '../lib/GlobalMiningStats.ts';
import { getDbPromise } from './helpers/dbPromise.ts';

export const useMiningStats = defineStore('miningStats', () => {
  let hasLoaded = false;
  let lastUpdatedFrameId: number | undefined;
  let updatePromise: Promise<void> | undefined = undefined;
  let isLoadedPromise: Promise<void> | undefined = undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempts = 0;
  let isDisposed = false;

  const mining = getMining();
  const currency = getCurrency();
  const stats = new GlobalMiningStats(
    mining,
    currency,
    getDbPromise().then(db => db.financialCacheTable),
  );

  const hasCurrentStats = Vue.ref(false);
  const isUpdating = Vue.ref(false);
  const error = Vue.ref('');
  const frameProgress = Vue.shallowRef(stats.frameProgress);

  const activeMiningSeatCount = Vue.ref(0);

  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref(0n);
  const investedCapital = Vue.ref(0n);
  const projectedProfit = Vue.ref(0n);

  const activeBidCosts = Vue.ref(0n);
  const activeBlockRewards = Vue.ref(0n);
  const averageAPR = Vue.ref<number>();
  const averageAPY = Vue.ref<number>();

  async function update(force = false) {
    if (updatePromise) return await updatePromise;

    const frameId = getBlockWatch().finalizedBlockHeader?.frameId;
    if (!force && hasLoaded && !error.value && frameId !== undefined && frameId === lastUpdatedFrameId) return;

    clearTimeout(retryTimer);
    retryTimer = undefined;
    isUpdating.value = true;
    error.value = '';

    updatePromise = (async () => {
      const publishProgress = () => {
        if (!isDisposed) frameProgress.value = stats.frameProgress;
      };
      if (!hasLoaded) {
        await stats.load(publishProgress);
        hasLoaded = true;
      } else {
        await stats.update(publishProgress);
      }
      if (isDisposed) return;

      hasCurrentStats.value = stats.hasCurrentStats;
      activeMiningSeatCount.value = stats.activeSeatCount;
      activeBidCosts.value = stats.activeBidCosts;
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
      lastUpdatedFrameId = frameId;
      retryAttempts = 0;
    } catch (cause) {
      if (!isDisposed) error.value = 'Unable to finish calculating mining returns.';
      scheduleRetry();
      throw cause;
    } finally {
      isUpdating.value = false;
      updatePromise = undefined;
      const latestFrameId = getBlockWatch().finalizedBlockHeader?.frameId;
      if (!isDisposed && !error.value && latestFrameId !== undefined && latestFrameId !== frameId) {
        void update().catch(error => console.warn('[MiningStats] Unable to refresh returns', error));
      }
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

  const unsubscribeFinalized = getBlockWatch().events.on('finalized', headers => {
    if (retryTimer || updatePromise) return;
    const frameId = headers.at(-1)?.frameId;
    const frameChanged = frameId !== undefined && frameId !== lastUpdatedFrameId;
    if (!frameChanged && retryAttempts < 3) return;

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
    frameProgress,
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
