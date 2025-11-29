import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter';
import { useConfig, type Config } from './config';
import { useWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '../lib/Utils';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';
import { PanelKey } from '../interfaces/IConfig';

export const useController = defineStore('controller', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = useConfig();
  const walletKeys = useWalletKeys();
  const panelKey = Vue.ref<PanelKey>('' as PanelKey);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(false);
  const stopSuggestingVaultTour = Vue.ref(false);

  const walletOverlayIsOpen = Vue.ref(false);

  function setPanelKey(value: PanelKey) {
    if (panelKey.value === value) return;

    basicEmitter.emit('closeAllOverlays');
    panelKey.value = value;
    config.panelKey = value;
    void config.save();
  }

  async function load() {
    await config.isLoadedPromise;
    panelKey.value = config.panelKey;
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
    panelKey,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    walletOverlayIsOpen,
    importFromFile,
    importFromMnemonic,
    setPanelKey,
  };
});
