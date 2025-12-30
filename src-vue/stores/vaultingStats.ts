import * as Vue from 'vue';
import { getVaults } from './vaults.ts';
import { defineStore } from 'pinia';
import { GlobalVaultingStats } from '@argonprotocol/apps-core';
import { getCurrency, Currency } from './currency.ts';

export const useVaultingStats = defineStore('vaultingStats', () => {
  let isLoading = false;
  let isLoadedPromise: Promise<void> | undefined = undefined;

  const vaults = getVaults();
  const currency = getCurrency();
  const stats = new GlobalVaultingStats(vaults, currency as Currency);

  const vaultCount = Vue.ref(0);
  const bitcoinLocked = Vue.ref(0);
  const microgonValueInVaults = Vue.ref(0n);
  const epochEarnings = Vue.ref(0n);
  const averageAPY = Vue.ref(0);

  const argonBurnCapability = Vue.ref(0);
  const finalPriceAfterTerraCollapse = Vue.ref(0n);

  async function update() {
    if (!isLoading && !isLoadedPromise) await stats.load();
    else if (!isLoading) await stats.update();
    isLoading = true;

    vaultCount.value = stats.vaultCount;
    bitcoinLocked.value = stats.bitcoinLocked;
    microgonValueInVaults.value = stats.microgonValueOfVaultedBitcoins;
    epochEarnings.value = stats.epochEarnings;
    averageAPY.value = stats.averageAPY;
    argonBurnCapability.value = stats.argonBurnCapability;
    finalPriceAfterTerraCollapse.value = stats.finalPriceAfterTerraCollapse;
    isLoading = false;
  }

  isLoadedPromise = update();

  return {
    vaultCount,
    microgonValueInVaults,
    bitcoinLocked,
    averageAPY,
    epochEarnings,
    argonBurnCapability,
    finalPriceAfterTerraCollapse,
    isLoadedPromise,
  };
});
