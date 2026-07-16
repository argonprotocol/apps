import * as Vue from 'vue';
import { defineStore } from 'pinia';
import handleFatalError from './helpers/handleFatalError.ts';
import {
  bigNumberToBigInt,
  calculateAPY,
  createDeferred,
  MICRONOTS_PER_ARGONOT,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { getCurrency } from './currency.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getWalletKeys, getWalletsForArgon, useWallets } from './wallets.ts';
import BigNumber from 'bignumber.js';

export const usePortfolio = defineStore('portfolio', () => {
  const currency = getCurrency();
  const wallets = useWallets();
  const dbPromise = getDbPromise();
  const walletKeys = getWalletKeys();
  const myMiningSeats = getMyMiningSeats();
  const walletsForArgon = getWalletsForArgon();

  let unsubscribes: VoidFunction[] = [];

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const vaultingExternalInvested = Vue.ref(0n);
  const miningExternalInvested = Vue.ref(0n);

  const originalCapitalInvested = Vue.computed(() => {
    return vaultingExternalInvested.value + miningExternalInvested.value;
  });

  const projectedApy = Vue.computed(() => {
    return calculateAPY(originalCapitalInvested.value, wallets.totalOperationalResources, myMiningSeats.activeFrames);
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
        const adjustedValueBn = BigNumber(valueOfMicronots)
          .multipliedBy(1 + targetOffset)
          .integerValue(BigNumber.ROUND_FLOOR);
        miningExternalInvested.value += bigNumberToBigInt(adjustedValueBn);
      }
    }

    const vaultFunding = await db.walletTransfersTable.fetchExternal(walletKeys.vaultingAddress);
    vaultingExternalInvested.value = 0n;
    for (const transfer of vaultFunding) {
      vaultingExternalInvested.value += transfer.amount;
    }
  }

  async function load() {
    await myMiningSeats.load();
    await updateExternalFunding();
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [
      walletsForArgon.events.on('transfer-in', updateExternalFunding),
      walletsForArgon.events.on('history:recovered', updateExternalFunding),
    ];

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

    originalCapitalInvested,

    projectedApy,
  };
});
