import * as Vue from 'vue';
import { getVaults } from './vaults.ts';
import { defineStore } from 'pinia';
import { GlobalVaultingStats } from '../../core/src/GlobalVaultingStats.ts';

export const useVaultingStats = defineStore('vaultingStats', () => {
  const vaults = getVaults();

  const vaultCount = Vue.ref(0);
  const bitcoinLocked = Vue.ref(0);
  const microgonValueInVaults = Vue.ref(0n);
  const epochEarnings = Vue.ref(0n);
  const averageVaultAPY = Vue.ref(0);

  async function load() {
    const stats = new GlobalVaultingStats(vaults);
    await stats.load();
    vaultCount.value = stats.vaultCount;
    bitcoinLocked.value = stats.bitcoinLocked;
    microgonValueInVaults.value = stats.microgonValueInVaults;
    epochEarnings.value = stats.epochEarnings;
    averageVaultAPY.value = stats.averageAPY;
  }

  const isLoadedPromise = load();

  return {
    vaultCount,
    microgonValueInVaults,
    bitcoinLocked,
    averageVaultAPY,
    epochEarnings,
    isLoadedPromise,
  };
});
