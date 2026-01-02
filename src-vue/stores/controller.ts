import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter';
import { getConfig, type Config } from './config';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';
import { ScreenKey } from '../interfaces/IConfig';

export const useController = defineStore('controller', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const screenKey = Vue.ref<ScreenKey>('' as ScreenKey);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(false);
  const stopSuggestingVaultTour = Vue.ref(false);

  const backButtonTriggersHome = Vue.ref(false);

  const walletOverlayIsOpen = Vue.ref(false);

  function setScreenKey(value: ScreenKey) {
    if (screenKey.value === value) return;

    basicEmitter.emit('closeAllOverlays');
    screenKey.value = value;
    config.screenKey = value;
    void config.save();
  }

  async function load() {
    await config.isLoadedPromise;
    screenKey.value = config.screenKey;
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

  load().catch(handleFatalError.bind('useController'));

  return {
    screenKey,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    walletOverlayIsOpen,
    backButtonTriggersHome,
    importFromFile,
    importFromMnemonic,
    setScreenKey: setScreenKey,
  };
});
