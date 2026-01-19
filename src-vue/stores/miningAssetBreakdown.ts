import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { useWallets } from './wallets.ts';
import { getCurrency } from './currency.ts';
import { getConfig } from './config.ts';
import { getStats } from './stats.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';
import BigNumber from 'bignumber.js';

export const useMiningAssetBreakdown = defineStore('miningAssetBreakdown', () => {
  const config = getConfig();
  const wallets = useWallets();
  const currency = getCurrency();
  const stats = getStats();

  // Sidelined

  const sidelinedMicrogons = Vue.computed(() => {
    return wallets.miningHoldWallet.totalMicrogons;
  });

  const sidelinedMicronots = Vue.computed(() => {
    return wallets.miningHoldWallet.totalMicronots;
  });

  const sidelinedTotalValue = Vue.computed(() => {
    return sidelinedMicrogons.value + currency.convertMicronotTo(sidelinedMicronots.value, UnitOfMeasurement.Microgon);
  });

  // Auction

  const auctionBidCount = Vue.computed(() => {
    return stats.myMiningBids.bidCount;
  });

  const auctionMicrogonsTotal = Vue.computed(() => {
    const microgons = auctionMicrogonsUnused.value + auctionMicrogonsActivated.value;
    return microgons > 0n ? microgons : 0n;
  });

  const auctionMicrogonsActivated = Vue.computed(() => {
    return wallets.miningBidMicrogons;
  });

  const auctionMicrogonsUnused = Vue.computed(() => {
    return wallets.miningBotWallet.availableMicrogons;
  });

  const auctionMicrogonsActivatedPct = Vue.computed(() => {
    const pctBn = BigNumber(auctionMicrogonsActivated.value).div(auctionMicrogonsTotal.value);

    return pctBn.multipliedBy(100).toNumber();
  });

  const auctionMicronotsTotal = Vue.computed(() => {
    const micronots = auctionMicronotsUnused.value + auctionMicronotsActivated.value;
    return micronots > 0n ? micronots : 0n;
  });

  const auctionMicronotsActivated = Vue.computed(() => {
    return wallets.miningBidMicronots;
  });

  const auctionMicronotsUnused = Vue.computed(() => {
    return wallets.miningBotWallet.availableMicronots;
  });

  const auctionMicronotsActivatedPct = Vue.computed(() => {
    const pctBn = BigNumber(auctionMicronotsActivated.value).div(auctionMicronotsTotal.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const auctionTotalValue = Vue.computed(() => {
    return (
      auctionMicrogonsTotal.value + currency.convertMicronotTo(auctionMicronotsTotal.value, UnitOfMeasurement.Microgon)
    );
  });

  // Mining Seats

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

  // Transaction Fees

  const transactionFeesTotal = Vue.computed(() => {
    return stats.global.transactionFeesTotal;
  });

  // Total Mining Resources

  const totalMiningResources = Vue.computed(() => {
    return wallets.totalMiningResources;
  });

  return {
    sidelinedMicrogons,
    sidelinedMicronots,
    sidelinedTotalValue,

    auctionBidCount,
    auctionTotalValue,
    auctionMicrogonsTotal,
    auctionMicronotsTotal,

    auctionMicrogonsUnused,
    auctionMicronotsUnused,

    auctionMicrogonsActivated,
    auctionMicronotsActivated,

    auctionMicrogonsActivatedPct,
    auctionMicronotsActivatedPct,

    seatActiveCount,
    stakedSeatMicronots,
    expectedSeatValue,
    expectedSeatMicrogons,
    expectedSeatMicronots,
    transactionFeesTotal,
    totalMiningResources,
  };
});
