import * as Vue from 'vue';
import { getVaults } from './vaults.ts';
import { defineStore } from 'pinia';
import { GlobalVaultingStats } from '@argonprotocol/apps-core';
import { getCurrency } from './currency.ts';

export const useVaultingStats = defineStore('vaultingStats', () => {
  let hasLoaded = false;
  let updatePromise: Promise<void> | undefined = undefined;
  let isLoadedPromise: Promise<void> | undefined = undefined;

  const vaults = getVaults();
  const currency = getCurrency();
  const stats = new GlobalVaultingStats(vaults, currency);

  const vaultCount = Vue.ref(0);
  const bitcoinLocked = Vue.ref(0);
  const microgonValueInVaults = Vue.ref(0n);
  const epochEarnings = Vue.ref(0n);
  const averageAPY = Vue.ref(0);

  const argonBurnCapacity = Vue.ref(0);
  const finalPriceAfterTerraCollapse = Vue.ref(0n);

  async function update() {
    if (updatePromise) return await updatePromise;

    updatePromise = (async () => {
      if (!hasLoaded) {
        await stats.load();
        hasLoaded = true;
      } else {
        await stats.update();
      }

      vaultCount.value = stats.vaultCount;
      bitcoinLocked.value = stats.bitcoinLocked;
      microgonValueInVaults.value = stats.microgonValueOfVaultedBitcoins;
      epochEarnings.value = stats.epochEarnings;
      averageAPY.value = stats.activeAPY;
      argonBurnCapacity.value = stats.argonBurnCapacity;
      finalPriceAfterTerraCollapse.value = stats.finalPriceAfterTerraCollapse;
    })();

    try {
      await updatePromise;
    } finally {
      updatePromise = undefined;
    }
  }

  isLoadedPromise = update();

  return {
    vaultCount,
    microgonValueInVaults,
    bitcoinLocked,
    averageAPY,
    epochEarnings,
    argonBurnCapacity,
    finalPriceAfterTerraCollapse,
    isLoadedPromise,
    update,
  };
});
