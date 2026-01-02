import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { useWallets } from './wallets.ts';
import { getCurrency } from './currency.ts';
import { getConfig } from './config.ts';
import { getStats } from './stats.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';

export const useMiningAssetBreakdown = defineStore('miningAssetBreakdown', () => {
  const config = getConfig();
  const wallets = useWallets();
  const currency = getCurrency();
  const stats = getStats();

  const unusedMicronots = Vue.computed(() => {
    const unused = wallets.miningWallet.availableMicronots - config.biddingRules.sidelinedMicronots;
    return unused > 0n ? unused : 0n;
  });

  const unusedMicrogons = Vue.computed(() => {
    const unused = wallets.miningWallet.availableMicrogons - config.biddingRules.sidelinedMicrogons;
    return unused > 0n ? unused : 0n;
  });

  const biddingReserves = Vue.computed(() => {
    return unusedMicrogons.value + currency.convertMicronotTo(unusedMicronots.value, UnitOfMeasurement.Microgon);
  });

  const bidTotalCount = Vue.computed(() => {
    return stats.myMiningBids.bidCount;
  });

  const bidTotalCost = Vue.computed(() => {
    return wallets.miningBidValue;
  });

  const bidMicrogons = Vue.computed(() => {
    return wallets.miningBidMicrogons;
  });

  const bidMicronots = Vue.computed(() => {
    return wallets.miningBidMicronots;
  });

  const seatActiveCount = Vue.computed(() => {
    return stats.myMiningSeats.seatCount;
  });

  const expectedSeatValue = Vue.computed(() => {
    return wallets.miningSeatValue;
  });

  const stakedSeatMicronots = Vue.computed(() => wallets.miningSeatStakedMicronots);

  const expectedSeatMicrogons = Vue.computed(() => {
    return wallets.miningSeatMicrogons;
  });

  const expectedSeatMicronots = Vue.computed(() => {
    return wallets.miningSeatMicronots;
  });

  const totalMiningResources = Vue.computed(() => {
    return wallets.totalMiningResources;
  });

  const transactionFeesTotal = Vue.computed(() => {
    return stats.global.transactionFeesTotal;
  });

  return {
    biddingReserves,
    unusedMicrogons,
    unusedMicronots,
    bidTotalCount,
    bidTotalCost,
    bidMicrogons,
    bidMicronots,
    seatActiveCount,
    stakedSeatMicronots,
    expectedSeatValue,
    expectedSeatMicrogons,
    expectedSeatMicronots,
    transactionFeesTotal,
    totalMiningResources,
  };
});
