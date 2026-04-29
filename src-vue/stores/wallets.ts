import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig } from './config.ts';
import { createDeferred, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getStats } from './stats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { IS_TREASURY_APP, IS_OPERATIONS_APP, SECURITY } from '../lib/Env.ts';
import { getSpendableMiningHoldMicrogons, IArgonWalletType } from '../lib/WalletForArgon.ts';
import { IWallet, type IOtherToken, defaultWalletData } from '../lib/Wallet.ts';
import { IWalletEvents, WalletsForArgon } from '../lib/WalletsForArgon.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';
import { getMyVault } from './vaults.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletForBase } from '../lib/WalletForBase.ts';

let walletKeys: WalletKeys;
export function getWalletKeys() {
  walletKeys ??= new WalletKeys(SECURITY, async () => {
    const walletsForArgon = getWalletsForArgon();
    await walletsForArgon.load();
    return walletsForArgon.didWalletHavePreviousLife();
  });
  return walletKeys;
}

let walletsForArgon: WalletsForArgon;
export function getWalletsForArgon() {
  if (!walletsForArgon) {
    const myVault = IS_OPERATIONS_APP ? getMyVault() : undefined;
    walletsForArgon = new WalletsForArgon(getWalletKeys(), getDbPromise(), getBlockWatch(), myVault);
  }
  return walletsForArgon;
}

export const useWallets = defineStore('wallets', () => {
  const stats = getStats();
  const currency = getCurrency();
  const config = getConfig();
  const walletKeys = getWalletKeys();

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const walletsForArgon = getWalletsForArgon();
  const walletForEthereum = new WalletForEthereum(walletKeys.ethereumAddress);
  const walletForBase = new WalletForBase(walletKeys.ethereumAddress);

  const miningHoldWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.miningHoldAddress });
  const miningBotWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.miningBotAddress });
  const vaultingWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.vaultingAddress });
  const operationalWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.operationalAddress });
  const investmentWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.investmentAddress });

  const ethereumWallet = Vue.reactive<IWallet>(walletForEthereum.data);
  const baseWallet = Vue.reactive<IWallet>(walletForBase.data);
  walletForEthereum.data = ethereumWallet;
  walletForBase.data = baseWallet;

  const liquidLockingWallet = Vue.computed(() => {
    return IS_TREASURY_APP ? investmentWallet : vaultingWallet;
  });

  const miningHoldSpendableMicrogons = Vue.computed(() => {
    return getSpendableMiningHoldMicrogons(miningHoldWallet.availableMicrogons);
  });

  const miningHoldDisplayedMicrogons = Vue.computed(() => {
    return miningHoldSpendableMicrogons.value + miningHoldWallet.reservedMicrogons;
  });

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
      miningHoldSpendableMicrogons.value +
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
      miningHoldDisplayedMicrogons.value +
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

  const totalOperationalResources = Vue.computed(() => {
    return totalMiningResources.value + totalVaultingResources.value;
  });

  const totalTreasuryResources = Vue.computed(() => {
    const microgonValue =
      investmentWallet.availableMicrogons + investmentWallet.reservedMicrogons + ethereumWallet.availableMicrogons;
    const micronotValue =
      currency.convertMicronotTo(investmentWallet.availableMicronots, UnitOfMeasurement.Microgon) +
      currency.convertMicronotTo(ethereumWallet.availableMicronots, UnitOfMeasurement.Microgon);
    const otherTokenValue = ethereumWallet.otherTokens.reduce((totalValue, token) => {
      return totalValue + currency.convertOtherToMicrogon(token as IOtherToken);
    }, 0n);

    return microgonValue + micronotValue + otherTokenValue;
  });

  const totalWalletMicrogons = Vue.ref(0n);
  const totalWalletMicronots = Vue.ref(0n);

  const walletMapping = {
    miningHold: miningHoldWallet,
    miningBot: miningBotWallet,
    vaulting: vaultingWallet,
    operational: operationalWallet,
    investment: investmentWallet,
  } satisfies Record<IArgonWalletType, IWallet>;

  //////////////////////////////////////////////////////////////////////////////
  walletsForArgon.events.on('balance-change', (entry, type) => {
    totalWalletMicrogons.value = walletsForArgon.totalWalletMicrogons;
    totalWalletMicronots.value = walletsForArgon.totalWalletMicronots;
    const wallet = walletMapping[type];
    Object.assign(wallet, entry);
    const walletEntry = walletsForArgon[`${type}Wallet`];
    wallet.totalMicrogons = walletEntry.totalMicrogons;
    wallet.totalMicronots = walletEntry.totalMicronots;
  });

  async function load() {
    for (let i = 0; i < 2; i++) {
      try {
        await config.isLoadedPromise;
        await Promise.all([walletsForArgon.load(), walletForEthereum.load(), walletForBase.load()]);

        totalWalletMicrogons.value = walletsForArgon.totalWalletMicrogons;
        totalWalletMicronots.value = walletsForArgon.totalWalletMicronots;
        for (const [walletType, wallet] of Object.entries(walletMapping)) {
          const key = walletType as keyof typeof walletMapping;
          const walletEntry = walletsForArgon[`${key}Wallet`];
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
        // TODO: this is a bit of a hack to make sure we don't get stuck in a loop. We should replace this with setting
        //  fetchErrorMsg on each wallet.
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
    operationalWallet,
    investmentWallet,
    ethereumWallet,
    baseWallet,
    liquidLockingWallet,

    miningHoldSpendableMicrogons,
    miningHoldDisplayedMicrogons,
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
    totalOperationalResources,

    totalTreasuryResources,

    on<K extends keyof IWalletEvents>(event: K, cb: IWalletEvents[K]): () => void {
      const unsub = walletsForArgon.events.on(event, cb);
      // re-emit any load events that happened before we subscribed
      if (!walletsForArgon.deferredLoading.isSettled) {
        void walletsForArgon.deferredLoading.promise.then(() => {
          const events = walletsForArgon.getLoadEvents(event);
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
