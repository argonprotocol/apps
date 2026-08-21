import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter.ts';
import { type Config, getConfig } from './config.ts';
import { getWalletsForArgon, getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError.ts';
import Importer from '../lib/Importer.ts';

export const useTreasuryController = defineStore('treasuryController', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const walletKeys = getWalletKeys();

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(false);
  const stopSuggestingVaultTour = Vue.ref(false);

  async function load() {
    await config.isLoadedPromise;
    const walletsForArgon = getWalletsForArgon();
    await walletsForArgon.load();
    isLoaded.value = true;
    isLoadedResolve();
  }

  async function importFromMnemonic(mnemonic: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    try {
      await importer.importFromMnemonic(mnemonic);
    } finally {
      isImporting.value = false;
    }
  }

  load().catch(handleFatalError.bind('useTreasuryController'));

  return {
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    importFromMnemonic,
  };
});
