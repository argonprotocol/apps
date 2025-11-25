import * as Vue from 'vue';
import { useVaults } from './vaults.ts';
import { SATOSHIS_PER_BITCOIN } from '../lib/Currency.ts';
import { defineStore } from 'pinia';

export const useVaultingStats = defineStore('vaultingStats', () => {
  const vaultsStore = useVaults();

  const vaultCount = Vue.ref(0);

  const bitcoinLocked = Vue.ref(0);
  const microgonValueInVaults = Vue.ref(0n);

  const averageVaultAPY = Vue.ref(0);

  async function load() {
    await vaultsStore.load();

    const vaultApys: number[] = [];
    const list = Object.values(vaultsStore.vaultsById);
    for (const vault of list) {
      const apy = vaultsStore.calculateVaultApy(vault.vaultId);
      vaultApys.push(apy);
    }

    const satsLocked = vaultsStore.getTotalSatoshisLocked();
    bitcoinLocked.value = Number(satsLocked) / Number(SATOSHIS_PER_BITCOIN);
    vaultsStore
      .getMarketRate(satsLocked)
      .then(rate => {
        microgonValueInVaults.value = rate;
      })
      .catch(() => {
        microgonValueInVaults.value = 0n;
      });
    vaultCount.value = list.length;

    if (vaultApys.length > 0) {
      averageVaultAPY.value = vaultApys.reduce((a, b) => a + b, 0) / vaultApys.length;
    } else {
      averageVaultAPY.value = 0;
    }
  }

  const isLoadedPromise = load();

  return {
    vaultCount,
    microgonValueInVaults,
    bitcoinLocked,
    averageVaultAPY,
    isLoadedPromise,
  };
});
