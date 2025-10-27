import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import { getMainchainClients } from './mainchain.ts';
import handleFatalError from './helpers/handleFatalError.ts';
import { useConfig } from './config.ts';
import { createDeferred } from '../lib/Utils.ts';
import { useStats } from './stats.ts';
import { useCurrency } from './currency.ts';
import { botEmitter } from '../lib/Bot.ts';
import { BotStatus } from '../lib/BotSyncer.ts';
import { IWallet as IWalletBasic, WalletBalances } from '../lib/WalletBalances.ts';
import { MiningFrames } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';

const config = useConfig();

export interface IWallet extends IWalletBasic {
  name: string;
}

export const useWallets = defineStore('wallets', () => {
  const stats = useStats();
  const currency = useCurrency();

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const miningWallet = Vue.reactive<IWallet>({
    name: 'Mining Wallet',
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  });

  const vaultingWallet = Vue.reactive<IWallet>({
    name: 'Vaulting Wallet',
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  });

  const microgonsCommittedToMiningBot = Vue.computed(() => {
    return config.biddingRules.baseMicrogonCommitment + stats.accruedMicrogonProfits;
  });

  const micronotsCommittedToMiningBot = Vue.computed(() => {
    return config.vaultingRules.baseMicronotCommitment + stats.accruedMicronotProfits;
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
    return miningWallet.availableMicrogons + miningSeatMicrogons.value + miningBidMicrogons.value;
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

  const walletBalances = new WalletBalances(getMainchainClients());
  walletBalances.onBalanceChange = () => {
    totalWalletMicrogons.value = walletBalances.totalWalletMicrogons;
    totalWalletMicronots.value = walletBalances.totalWalletMicronots;

    miningWallet.address = walletBalances.miningWallet.address;
    miningWallet.availableMicrogons = walletBalances.miningWallet.availableMicrogons;
    miningWallet.availableMicronots = walletBalances.miningWallet.availableMicronots;
    miningWallet.reservedMicronots = walletBalances.miningWallet.reservedMicronots;
    miningWallet.reservedMicrogons = walletBalances.miningWallet.reservedMicrogons;

    vaultingWallet.address = walletBalances.vaultingWallet.address;
    vaultingWallet.availableMicrogons = walletBalances.vaultingWallet.availableMicrogons;
    vaultingWallet.availableMicronots = walletBalances.vaultingWallet.availableMicronots;
    vaultingWallet.reservedMicronots = walletBalances.vaultingWallet.reservedMicronots;
    vaultingWallet.reservedMicrogons = walletBalances.vaultingWallet.reservedMicrogons;
  };

  async function load() {
    while (!isLoaded.value) {
      try {
        await config.isLoadedPromise;
        await walletBalances.load({
          miningAccountAddress: config.miningAccount.address,
          vaultingAccountAddress: config.vaultingAccount.address,
        });
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
    totalVaultingMicrogons,
    totalMiningResources,
    totalVaultingResources,
    totalNetWorth,
    microgonsCommittedToMiningBot,
    micronotsCommittedToMiningBot,
  };
});
