import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig } from './config.ts';
import {
  calculateAPY,
  calculateProfitPct,
  createDeferred,
  MICRONOTS_PER_ARGONOT,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { getStats } from './stats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { SECURITY } from '../lib/Env.ts';
import { IWallet } from '../lib/Wallet.ts';
import { IWalletEvents, WalletBalances } from '../lib/WalletBalances.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';
import { getMyVault } from './vaults.ts';
import { getWalletBalances, getWalletKeys, useWallets } from './wallets.ts';
import BigNumber from 'bignumber.js';

export const usePortfolio = defineStore('portfolio', () => {
  const stats = getStats();
  const currency = getCurrency();
  const config = getConfig();
  const wallets = useWallets();
  const dbPromise = getDbPromise();
  const walletKeys = getWalletKeys();
  const walletBalances = getWalletBalances();
  const myMinerStats = getStats();

  let unsubscribe: (() => void) | undefined;

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const vaultingExternalInvested = Vue.ref(0n);
  const miningExternalInvested = Vue.ref(0n);

  const originalCapitalRoi = Vue.computed(() => {
    return calculateProfitPct(originalCapitalInvested.value, wallets.totalNetWorth) * 100;
  });

  const originalCapitalInvested = Vue.computed(() => {
    return vaultingExternalInvested.value + miningExternalInvested.value;
  });

  const projectedApy = Vue.computed(() => {
    return calculateAPY(originalCapitalInvested.value, wallets.totalNetWorth, myMinerStats.activeFrames);
  });

  async function updateExternalFunding() {
    const db = await dbPromise;
    const microgonsPerArgonot = currency.convertMicronotTo(BigInt(MICRONOTS_PER_ARGONOT), UnitOfMeasurement.Microgon);
    const miningFunding = await db.walletTransfersTable.fetchExternal(walletKeys.miningBotAddress);
    miningExternalInvested.value = 0n;

    for (const transfer of miningFunding) {
      if (transfer.currency === 'argon') {
        miningExternalInvested.value += transfer.amount;
      } else {
        const targetOffset =
          currency.calculateTargetOffset(BigNumber(transfer.microgonsForArgonot), BigNumber(microgonsPerArgonot)) || 1;
        const valueOfMicronots = currency.convertMicronotTo(transfer.amount, UnitOfMeasurement.Microgon);
        const adjustedValue = Math.floor(Number(valueOfMicronots) * (1 + targetOffset));
        miningExternalInvested.value += BigInt(adjustedValue);
      }
    }

    const vaultFunding = await db.walletTransfersTable.fetchExternal(walletKeys.vaultingAddress);
    vaultingExternalInvested.value = 0n;
    for (const transfer of vaultFunding) {
      vaultingExternalInvested.value += transfer.amount;
    }
  }

  async function load() {
    await myMinerStats.load();
    await updateExternalFunding();
    unsubscribe = walletBalances.events.on('transfer-in', async () => {
      await updateExternalFunding();
    });

    isLoadedResolve();
    isLoaded.value = true;
  }

  load().catch(error => {
    console.log('Error loading portfolio:', error);
    void handleFatalError.bind('usePortfolio')(error);
    isLoadedReject();
  });

  return {
    isLoaded,
    isLoadedPromise,

    vaultingExternalInvested,
    miningExternalInvested,

    originalCapitalRoi,
    originalCapitalInvested,

    projectedApy,
  };
});
