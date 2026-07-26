import * as Vue from 'vue';
import { getVaults } from './vaults.ts';
import { defineStore } from 'pinia';
import { BitcoinPrices, calculateBitcoinRatchetReturn, GlobalVaultingStats } from '@argonprotocol/apps-core';
import { getCurrency } from './currency.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

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
  const averageAPR = Vue.ref(0);
  const averageAPY = Vue.ref(0);
  const argonBondsAPR = Vue.ref(0);
  const argonotStakingAPR = Vue.ref(0);

  const argonBurnCapacity = Vue.ref(0);
  const finalPriceAfterTerraCollapse = Vue.ref(0n);

  const bitcoinPrices = new BitcoinPrices().getDateRange(
    dayjs.utc().subtract(1, 'year').format('YYYY-MM-DD'),
    dayjs.utc().format('YYYY-MM-DD'),
  );
  const bitcoinAPR = calculateBitcoinRatchetReturn({
    prices: bitcoinPrices,
    flatFee: 2,
    percentageFee: 5,
    ratchetThreshold: 0.1,
  }).percent;

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
      averageAPR.value = stats.activeAPR;
      averageAPY.value = stats.activeAPY;
      argonBondsAPR.value = stats.argonBondsAPR;
      argonotStakingAPR.value = stats.argonotStakingAPR;
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
    bitcoinAPR,
    averageAPR,
    averageAPY,
    argonBondsAPR,
    argonotStakingAPR,
    epochEarnings,
    argonBurnCapacity,
    finalPriceAfterTerraCollapse,
    isLoadedPromise,
    update,
  };
});
