import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter';
import { getConfig, type Config } from './config';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';

export enum OperationsTab {
  Home = 'Home',
  Mining = 'Mining',
  Vaulting = 'Vaulting',
}

export const useOperationsController = defineStore('operationsController', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const selectedTab = Vue.ref<OperationsTab>(OperationsTab.Home);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(true);
  const stopSuggestingVaultTour = Vue.ref(true);

  const backButtonTriggersHome = Vue.ref(false);

  const walletOverlayIsOpen = Vue.ref(false);

  function setTab(tab: OperationsTab) {
    if (selectedTab.value === tab) return;

    basicEmitter.emit('closeAllOverlays');
    selectedTab.value = tab;
  }

  async function load() {
    await config.isLoadedPromise;
    isLoaded.value = true;
    isLoadedResolve();
  }

  async function importFromFile(dataRaw: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    basicEmitter.emit('openImportingOverlay', { importer, dataRaw });
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
    walletOverlayIsOpen,
    backButtonTriggersHome,
    importFromFile,
    importFromMnemonic,
    setScreenKey: setTab,
  };
});
