import * as Vue from 'vue';
import { defineStore } from 'pinia';
import type { Vault } from '@argonprotocol/mainchain';
import basicEmitter from '../emitters/basicEmitter';
import { type Config, getConfig } from './config';
import { getWalletsForArgon, getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';
import { getVaults } from './vaults.ts';

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
  const vaults = getVaults();
  const selectedTab = Vue.ref<TreasuryTab>(TreasuryTab.MainchainSavings);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(false);
  const stopSuggestingVaultTour = Vue.ref(false);
  let selectedVaultSubscriptionKey = 0;
  let unsubSelectedVault: (() => void) | undefined;

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
    const walletsForArgon = getWalletsForArgon();
    await walletsForArgon.load();
    isLoaded.value = true;
    isLoadedResolve();
  }

  function syncUpstreamOperatorName(vault: Vault) {
    const upstreamOperator = config.upstreamOperator;
    if (!upstreamOperator || upstreamOperator.vaultId !== vault.vaultId) return;
    if (upstreamOperator.name) return;

    const nextName = vault.name;
    if (!nextName) return;

    config.upstreamOperator = {
      ...upstreamOperator,
      name: nextName,
    };
    void config.save();
  }

  async function importFromMnemonic(mnemonic: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    await importer.importFromMnemonic(mnemonic);
    isImporting.value = false;
  }

  Vue.watch(
    () => (config.isLoaded ? (config.upstreamOperator?.vaultId ?? 0) : 0),
    vaultId => {
      selectedVaultSubscriptionKey += 1;
      const subscriptionKey = selectedVaultSubscriptionKey;

      unsubSelectedVault?.();
      unsubSelectedVault = undefined;

      if (!vaultId) return;

      void (async () => {
        await vaults.load().catch(() => null);
        if (subscriptionKey !== selectedVaultSubscriptionKey) return;

        const vault = vaults.vaultsById[vaultId];
        if (vault) {
          syncUpstreamOperatorName(vault);
        }

        const unsub = await vaults.subscribeToVault(vaultId, syncUpstreamOperatorName).catch(() => undefined);
        if (!unsub) return;
        if (subscriptionKey !== selectedVaultSubscriptionKey) {
          unsub();
          return;
        }

        unsubSelectedVault = unsub;
      })();
    },
    { immediate: true },
  );

  Vue.onScopeDispose(() => {
    selectedVaultSubscriptionKey += 1;
    unsubSelectedVault?.();
    unsubSelectedVault = undefined;
  });

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
