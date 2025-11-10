import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { useConfig } from './config.ts';
import { createDeferred } from '../lib/Utils.ts';
import { useStats } from './stats.ts';
import { useCurrency } from './currency.ts';
import { botEmitter } from '../lib/Bot.ts';
import { BotStatus } from '../lib/BotSyncer.ts';
import { IWallet as IWalletBasic } from '../lib/WalletBalances.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { SECURITY } from '../lib/Env.ts';

export interface IWallet extends IWalletBasic {
  name: string;
}

let walletKeys: WalletKeys;
export function useWalletKeys() {
  walletKeys ??= new WalletKeys(SECURITY);
  return walletKeys;
}

export const useWallets = defineStore('wallets', () => {
  const stats = useStats();
  const currency = useCurrency();
  const config = useConfig();

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const walletKeys = useWalletKeys();
  const walletBalances = walletKeys.getBalances();
  const miningWallet = Vue.reactive<IWallet>({
    name: 'Mining Wallet',
    ...walletBalances.miningWallet,
  });

  const vaultingWallet = Vue.reactive<IWallet>({
    name: 'Vaulting Wallet',
    ...walletBalances.vaultingWallet,
  });

  const previousHistoryValue = Vue.computed(() => {
    if (!config.miningAccountPreviousHistory) return;
    const bids = { microgons: 0n, micronots: 0n };
    const seats = { microgons: 0n, micronots: 0n };

    for (const item of config.miningAccountPreviousHistory) {
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
    return stats.myMiningSeats.microgonValueRemaining;
  });

  const miningSeatMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.micronots;
    }
    return stats.myMiningSeats.micronotsStakedTotal;
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

  const miningSeatValue = Vue.computed(() => {
    return miningSeatMicrogons.value + currency.micronotToMicrogon(miningSeatMicronots.value);
  });

  const miningBidValue = Vue.computed(() => {
    return miningBidMicrogons.value + currency.micronotToMicrogon(miningBidMicronots.value);
  });

  const totalMiningMicrogons = Vue.computed(() => {
    return (
      miningWallet.availableMicrogons +
      miningSeatMicrogons.value +
      miningBidMicrogons.value -
      config.biddingRules.sidelinedMicrogons
    );
  });

  const totalMiningMicronots = Vue.computed(() => {
    return miningWallet.availableMicronots + miningWallet.reservedMicronots - config.biddingRules.sidelinedMicronots;
  });

  const totalVaultingMicrogons = Vue.computed(() => {
    // TBD: add in current vault value
    return vaultingWallet.availableMicrogons + vaultingWallet.reservedMicrogons;
  });

  const totalMiningResources = Vue.computed(() => {
    return (
      miningWallet.availableMicrogons +
      currency.micronotToMicrogon(miningWallet.availableMicronots) +
      miningSeatValue.value +
      miningBidValue.value
    );
  });

  const totalVaultingResources = Vue.computed(() => {
    return (
      vaultingWallet.availableMicrogons +
      vaultingWallet.reservedMicrogons +
      currency.micronotToMicrogon(vaultingWallet.availableMicronots) +
      currency.micronotToMicrogon(vaultingWallet.reservedMicronots)
    );
  });

  const totalNetWorth = Vue.computed(() => {
    return totalMiningResources.value + totalVaultingResources.value;
  });

  const totalWalletMicrogons = Vue.ref(0n);
  const totalWalletMicronots = Vue.ref(0n);

  //////////////////////////////////////////////////////////////////////////////
  walletBalances.onBalanceChange = () => {
    totalWalletMicrogons.value = walletBalances.totalWalletMicrogons;
    totalWalletMicronots.value = walletBalances.totalWalletMicronots;

    Object.assign(miningWallet, walletBalances.miningWallet);
    Object.assign(vaultingWallet, walletBalances.vaultingWallet);
  };

  async function load() {
    while (!isLoaded.value) {
      try {
        await config.isLoadedPromise;
        await walletBalances.load();
        await walletBalances.subscribeToBalanceUpdates();
        await Promise.all([stats.isLoadedPromise, currency.isLoadedPromise]);
        isLoadedResolve();
        isLoaded.value = true;
      } catch (error) {
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

  botEmitter.on('status-changed', status => {
    if (isLoaded.value && status === BotStatus.Ready) {
      // Reload balances when bot status changes
      walletBalances.updateBalances().catch(error => {
        console.error('Error reloading wallet balances:', error);
      });
    }
  });

  return {
    isLoaded,
    isLoadedPromise,
    miningWallet,
    vaultingWallet,
    totalWalletMicrogons,
    totalWalletMicronots,
    miningSeatValue,
    miningBidValue,
    miningSeatMicrogons,
    miningSeatMicronots,
    miningBidMicrogons,
    miningBidMicronots,
    totalMiningMicrogons,
    totalMiningMicronots,
    totalVaultingMicrogons,
    totalMiningResources,
    totalVaultingResources,
    totalNetWorth,
  };
});
