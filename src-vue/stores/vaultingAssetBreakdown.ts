import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useWallets } from './wallets.ts';
import { getMyVault } from './vaults.ts';
import { getCurrency } from './currency.ts';
import { MyVault } from '../lib/MyVault.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const wallets = useWallets();
  const myVault = getMyVault();
  const currency = getCurrency();

  // Sidelined

  const sidelinedMicrogons = Vue.computed(() => {
    return bigIntMax(wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves, 0n);
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
    return bigIntMax(0n, vault.availableSecuritization() - vault.getRelockCapacity());
  });

  const securityMicrogonsPending = Vue.computed(() => {
    return myVault.createdVault?.securitizationPendingActivation ?? 0n;
  });

  const securityMicrogonsActivated = Vue.computed<bigint>(() => {
    return myVault.createdVault?.securitizationLocked ?? 0n;
  });

  const securityMicrogonsActivatedPct = Vue.computed<number>(() => {
    const pctBn = BigNumber(securityMicrogonsActivated.value).div(securityMicrogons.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const securityMicronots = Vue.computed(() => wallets.vaultingWallet.availableMicronots);
  const securityMicronotsUnused = Vue.computed(() => wallets.vaultingWallet.availableMicronots);
  const securityMicronotsPending = Vue.computed(() => 0n);
  const securityMicronotsActivated = Vue.computed(() => 0n);
  const securityMicronotsActivatedPct = Vue.computed(() => 100);

  const securityTotalValue = Vue.computed(() => {
    return securityMicrogons.value + currency.convertMicronotTo(securityMicronots.value, UnitOfMeasurement.Microgon);
  });

  // Treasury

  const treasuryMicrogons = Vue.computed(() => {
    return myVault.data.treasury.heldPrincipal;
  });

  const treasuryMicrogonsActivated = Vue.computed(() => {
    return bigIntMin(myVault.data.treasury.heldPrincipal, treasuryMicrogonsMaxCapacity.value);
  });

  const treasuryMicrogonsUnused = Vue.computed(() => {
    return bigIntMax(0n, myVault.data.treasury.targetPrincipal - treasuryMicrogonsActivated.value);
  });

  const treasuryMicrogonsActivatedPct = Vue.computed(() => {
    const pctBn = BigNumber(treasuryMicrogonsActivated.value).div(treasuryTotalValue.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const treasuryTotalValue = Vue.computed(() => {
    return treasuryMicrogons.value;
  });

  const treasuryMicrogonsMaxCapacity = Vue.computed(() => {
    return securityMicrogonsActivated.value;
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
    treasuryMicrogonsMaxCapacity,

    operationalFeeMicrogons,
    totalVaultValue,
  };
});
