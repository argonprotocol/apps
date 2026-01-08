import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useWallets } from './wallets.ts';
import { getMyVault } from './vaults.ts';
import { getCurrency } from './currency.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const wallets = useWallets();
  const myVault = getMyVault();
  const currency = getCurrency();

  // Sidelined

  const sidelinedMicrogons = Vue.computed(() => {
    return bigIntMax(wallets.vaultingWallet.availableMicrogons, 0n);
  });

  const sidelinedMicronots = Vue.computed(() => 0n);

  const sidelinedTotalValue = Vue.computed(() => {
    return sidelinedMicrogons.value + currency.convertMicronotTo(sidelinedMicronots.value, UnitOfMeasurement.Microgon);
  });

  // Security

  const securityMicrogons = Vue.computed(() => {
    return myVault.createdVault?.securitization ?? 0n;
  });

  const securityMicrogonsUnused = Vue.computed<bigint>(() => {
    const vault = myVault.createdVault;
    if (!vault) return 0n;

    const securitization = vault.securitization;
    const everActivatedSecuritization = bigNumberToBigInt(vault.securitizationRatioBN().times(vault.argonsLocked));
    return securitization - everActivatedSecuritization;
  });

  const securityMicrogonsPending = Vue.computed(() => {
    const vault = myVault.createdVault;
    if (!vault) return 0n;

    return bigNumberToBigInt(vault.securitizationRatioBN().times(vault.argonsPendingActivation));
  });

  const securityMicrogonsActivated = Vue.computed<bigint>(() => {
    // TODO: this value is wrong when there are pending activations and relocks
    // return myVault.createdVault?.activatedSecuritization() ?? 0n;
    return securityMicrogons.value - securityMicrogonsUnused.value;
  });

  const securityMicrogonsActivatedPct = Vue.computed<number>(() => {
    const pctBn = BigNumber(securityMicrogonsActivated.value).div(securityMicrogons.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const securityMicronots = Vue.computed(() => 0n);
  const securityMicronotsUnused = Vue.computed(() => 0n);
  const securityMicronotsPending = Vue.computed(() => 0n);
  const securityMicronotsActivated = Vue.computed(() => 0n);
  const securityMicronotsActivatedPct = Vue.computed(() => 100);

  const securityTotalValue = Vue.computed(() => {
    return securityMicrogons.value + currency.convertMicronotTo(securityMicronots.value, UnitOfMeasurement.Microgon);
  });

  // Treasury

  const treasuryMicrogons = Vue.computed(() => {
    return myVault.data.treasuryMicrogonsCommitted || 0n;
  });

  const treasuryMicrogonsActivated = Vue.computed(() => {
    return bigIntMin(securityMicrogonsActivated.value, treasuryMicrogons.value);
  });

  const treasuryMicrogonsUnused = Vue.computed(() => {
    return treasuryMicrogons.value - treasuryMicrogonsActivated.value;
  });

  const treasuryMicrogonsActivatedPct = Vue.computed(() => {
    const pctBn = BigNumber(treasuryMicrogonsActivated.value).div(treasuryTotalValue.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const treasuryTotalValue = Vue.computed(() => {
    return treasuryMicrogons.value;
  });

  // Operational Fees

  const operationalFeeMicrogons = Vue.computed(() => {
    return myVault.metadata?.operationalFeeMicrogons ?? 0n;
  });

  // Total Vault

  const totalVaultValue = Vue.computed(() => {
    return (
      sidelinedTotalValue.value + securityTotalValue.value + treasuryTotalValue.value - operationalFeeMicrogons.value
    );
  });

  return {
    sidelinedMicrogons,
    sidelinedMicronots,
    sidelinedTotalValue,

    securityMicrogons,
    securityMicronots,
    securityMicrogonsUnused,
    securityMicronotsUnused,
    securityMicrogonsPending,
    securityMicronotsPending,
    securityMicrogonsActivated,
    securityMicronotsActivated,
    securityMicrogonsActivatedPct,
    securityMicronotsActivatedPct,
    securityTotalValue,

    treasuryMicrogons,
    treasuryMicrogonsUnused,
    treasuryMicrogonsActivatedPct,
    treasuryTotalValue,

    operationalFeeMicrogons,
    totalVaultValue,
  };
});
