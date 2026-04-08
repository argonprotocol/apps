import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter';
import { getConfig, type Config } from './config';
import { getWalletBalances, getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';

export enum TreasuryTab {
  MainchainSavings = 'MainchainSavings',
  ArgonBonds = 'ArgonBonds',
  BitcoinLocks = 'BitcoinLocks',
  P2pSavings = 'P2pSavings',
  P2pTaxes = 'P2pTaxes',
  EthereumSwaps = 'EthereumSwaps',
}

export const useTreasuryController = defineStore('treasuryController', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const selectedTab = Vue.ref<TreasuryTab>(TreasuryTab.MainchainSavings);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(false);
  const stopSuggestingVaultTour = Vue.ref(false);

  function setTab(value: TreasuryTab) {
    if (selectedTab.value === value) return;

    basicEmitter.emit('closeAllOverlays');
    selectedTab.value = value;
    if (config.isLoaded) {
      void config.save();
    }
  }

  async function load() {
    await config.isLoadedPromise;
    const walletBalances = getWalletBalances();
    await walletBalances.load();
    isLoaded.value = true;
    isLoadedResolve();
  }

  async function importFromMnemonic(mnemonic: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    await importer.importFromMnemonic(mnemonic);
    isImporting.value = false;
  }

  load().catch(handleFatalError.bind('useOperationsController'));

  return {
    selectedTab,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    importFromMnemonic,
    setScreenKey: setTab,
  };
});
