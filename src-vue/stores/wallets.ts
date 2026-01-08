import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig } from './config.ts';
import { createDeferred, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getStats } from './stats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { SECURITY } from '../lib/Env.ts';
import { IWallet } from '../lib/Wallet.ts';
import { IWalletEvents, WalletBalances } from '../lib/WalletBalances.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';
import { getMyVault } from './vaults.ts';

let walletKeys: WalletKeys;
export function getWalletKeys() {
  walletKeys ??= new WalletKeys(SECURITY, async () => {
    const walletBalances = getWalletBalances();
    await walletBalances.load();
    return walletBalances.didWalletHavePreviousLife();
  });
  return walletKeys;
}

let walletBalances: WalletBalances;
export function getWalletBalances() {
  walletBalances ??= new WalletBalances(getWalletKeys(), getDbPromise(), getBlockWatch(), getMyVault());
  return walletBalances;
}

const defaultWallet: IWallet = {
  address: '',
  availableMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicrogons: 0n,
  reservedMicronots: 0n,
  totalMicronots: 0n,
  totalMicrogons: 0n,
};

export const useWallets = defineStore('wallets', () => {
  const stats = getStats();
  const currency = getCurrency();
  const config = getConfig();

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const walletKeys = getWalletKeys();
  const walletBalances = getWalletBalances();
  const miningHoldWallet = Vue.reactive<IWallet>({ ...defaultWallet, address: walletKeys.miningHoldAddress });
  const miningBotWallet = Vue.reactive<IWallet>({ ...defaultWallet, address: walletKeys.miningBotAddress });
  const vaultingWallet = Vue.reactive<IWallet>({ ...defaultWallet, address: walletKeys.vaultingAddress });

  const previousHistoryValue = Vue.computed(() => {
    if (!config.miningBotAccountPreviousHistory) return;
    const bids = { microgons: 0n, micronots: 0n };
    const seats = { microgons: 0n, micronots: 0n };

    for (const item of config.miningBotAccountPreviousHistory) {
      for (const seat of item.seats) {
        seats.microgons += seat.microgonsBid;
        seats.micronots += seat.micronotsStaked;
      }
      for (const bid of item.bids) {
        bids.microgons += bid.microgonsBid;
        bids.micronots += bid.micronotsStaked;
      }
    }

    return { bids, seats };
  });

  const miningSeatMicrogons = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.microgons;
    }
    return stats.myMiningSeats.microgonsToBeMined;
  });

  const miningSeatMicronots = Vue.computed(() => {
    return stats.myMiningSeats.micronotsToBeMined;
  });

  const miningSeatStakedMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.micronots;
    }
    return stats.myMiningSeats.micronotsStakedTotal;
  });

  const miningSeatValue = Vue.computed(() => {
    const micronots = miningSeatMicronots.value + miningSeatStakedMicronots.value;
    return miningSeatMicrogons.value + currency.convertMicronotTo(micronots, UnitOfMeasurement.Microgon);
  });

  const miningBidMicrogons = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.microgons;
    }
    return stats.myMiningBids.microgonsBidTotal;
  });

  const miningBidMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.micronots;
    }
    return stats.myMiningBids.micronotsStakedTotal;
  });

  const miningBidValue = Vue.computed(() => {
    return miningBidMicrogons.value + currency.convertMicronotTo(miningBidMicronots.value, UnitOfMeasurement.Microgon);
  });

  const totalMiningMicrogons = Vue.computed(() => {
    return (
      miningHoldWallet.availableMicrogons +
      miningBotWallet.availableMicrogons +
      miningSeatMicrogons.value +
      miningBidMicrogons.value -
      config.biddingRules.sidelinedMicrogons
    );
  });

  const totalMiningMicronots = Vue.computed(() => {
    return (
      miningHoldWallet.availableMicronots +
      miningHoldWallet.reservedMicronots +
      miningBotWallet.availableMicronots +
      miningBotWallet.reservedMicronots -
      config.biddingRules.sidelinedMicronots
    );
  });

  const totalVaultingMicrogons = Vue.computed(() => {
    // TBD: add in current vault value
    return vaultingWallet.availableMicrogons + vaultingWallet.reservedMicrogons;
  });

  const totalMiningResources = Vue.computed(() => {
    const holdings =
      miningHoldWallet.totalMicrogons +
      currency.convertMicronotTo(miningHoldWallet.totalMicronots, UnitOfMeasurement.Microgon);

    return (
      holdings +
      miningBotWallet.availableMicrogons +
      currency.convertMicronotTo(miningBotWallet.availableMicronots, UnitOfMeasurement.Microgon) +
      miningBidValue.value +
      miningSeatValue.value
    );
  });

  const totalVaultingResources = Vue.computed(() => {
    return (
      vaultingWallet.availableMicrogons +
      vaultingWallet.reservedMicrogons +
      currency.convertMicronotTo(vaultingWallet.availableMicronots, UnitOfMeasurement.Microgon) +
      currency.convertMicronotTo(vaultingWallet.reservedMicronots, UnitOfMeasurement.Microgon)
    );
  });

  const totalNetWorth = Vue.computed(() => {
    return totalMiningResources.value + totalVaultingResources.value;
  });

  const totalWalletMicrogons = Vue.ref(0n);
  const totalWalletMicronots = Vue.ref(0n);

  //////////////////////////////////////////////////////////////////////////////
  walletBalances.events.on('balance-change', (entry, type) => {
    totalWalletMicrogons.value = walletBalances.totalWalletMicrogons;
    totalWalletMicronots.value = walletBalances.totalWalletMicronots;
    const wallet = {
      miningHold: miningHoldWallet,
      miningBot: miningBotWallet,
      vaulting: vaultingWallet,
    }[type];
    Object.assign(wallet, entry);
    const walletEntry = walletBalances[`${type}Wallet`];
    wallet.totalMicrogons = walletEntry.totalMicrogons;
    wallet.totalMicronots = walletEntry.totalMicronots;
  });

  async function load() {
    for (let i = 0; i < 2; i++) {
      try {
        await config.isLoadedPromise;
        await walletBalances.load();
        totalWalletMicrogons.value = walletBalances.totalWalletMicrogons;
        totalWalletMicronots.value = walletBalances.totalWalletMicronots;
        for (const walletType of ['miningHold', 'miningBot', 'vaulting'] as const) {
          const wallet = {
            miningHold: miningHoldWallet,
            miningBot: miningBotWallet,
            vaulting: vaultingWallet,
          }[walletType];
          const walletEntry = walletBalances[`${walletType}Wallet`];
          Object.assign(wallet, walletEntry.latestBalanceChange);
          wallet.totalMicrogons = walletEntry.totalMicrogons;
          wallet.totalMicronots = walletEntry.totalMicronots;
        }
        await Promise.all([stats.isLoadedPromise, currency.isLoadedPromise]);
        isLoadedResolve();
        isLoaded.value = true;
        return;
      } catch (error) {
        console.error(`Error loading wallets`, error);
        const shouldRetry = await askDialog('Wallets failed to load correctly. Would you like to retry?', {
          title: 'Difficulty Loading Wallets',
          kind: 'warning',
        });
        if (!shouldRetry) {
          throw error;
        }
      }
    }
  }

  load().catch(error => {
    console.log('Error loading wallets:', error);
    void handleFatalError.bind('useWallets')(error);
    isLoadedReject();
  });

  return {
    isLoaded,
    isLoadedPromise,
    miningHoldWallet,
    miningBotWallet,
    vaultingWallet,
    totalWalletMicrogons,
    totalWalletMicronots,
    miningSeatValue,
    miningBidValue,
    miningSeatMicrogons,
    miningSeatMicronots,
    miningSeatStakedMicronots,
    miningBidMicrogons,
    miningBidMicronots,

    totalMiningMicrogons,
    totalMiningMicronots,
    totalVaultingMicrogons,
    totalMiningResources,
    totalVaultingResources,
    totalNetWorth,

    on: function <K extends keyof IWalletEvents>(event: K, cb: IWalletEvents[K]): () => void {
      const unsub = walletBalances.events.on(event, cb);
      // re-emit any load events that happened before we subscribed
      if (!walletBalances.deferredLoading.isSettled) {
        void walletBalances.deferredLoading.promise.then(() => {
          const events = walletBalances.getLoadEvents(event);
          for (const args of events) {
            // @ts-expect-error ts can't understand this pattern
            cb(...args);
          }
        });
      }
      return unsub;
    },
  };
});
