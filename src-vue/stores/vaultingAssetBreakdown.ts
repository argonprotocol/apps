import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, TreasuryPool, UnitOfMeasurement } from '@argonprotocol/apps-core';
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
    if (securityMicrogons.value <= 0n) return 0;

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
    return myVault.data.treasury.pendingReturnAmount;
  });

  const treasuryMicrogonsActivatedPct = Vue.computed(() => {
    if (treasuryMicrogonsMaxCapacity.value <= 0n) return 0;

    const pctBn = BigNumber(treasuryMicrogonsActivated.value).div(treasuryMicrogonsMaxCapacity.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const treasuryTotalValue = Vue.computed(() => {
    return treasuryMicrogons.value;
  });

  const treasuryMicrogonsMaxCapacity = Vue.computed(() => {
    const sats = BigInt(myVault.createdVault?.securitizedSatoshis ?? 0);
    if (sats <= 0n) return 0n;
    return currency.priceIndex.getBtcMicrogonPrice(sats);
  });

  // Treasury (all funders — for vault-wide utilization stats)

  const treasuryMicrogonsTotalBonded = Vue.computed(() => {
    return TreasuryPool.totalBondedCapital(myVault.data.bondFunders);
  });

  const treasuryMicrogonsTotalActivated = Vue.computed(() => {
    return bigIntMin(treasuryMicrogonsTotalBonded.value, treasuryMicrogonsMaxCapacity.value);
  });

  const treasuryMicrogonsTotalActivatedPct = Vue.computed(() => {
    if (treasuryMicrogonsMaxCapacity.value <= 0n) return 0;
    return BigNumber(treasuryMicrogonsTotalActivated.value)
      .div(BigNumber(treasuryMicrogonsMaxCapacity.value))
      .multipliedBy(100)
      .toNumber();
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
    treasuryMicrogonsActivated,
    treasuryMicrogonsActivatedPct,
    treasuryTotalValue,
    treasuryMicrogonsMaxCapacity,
    treasuryMicrogonsTotalBonded,
    treasuryMicrogonsTotalActivated,
    treasuryMicrogonsTotalActivatedPct,

    operationalFeeMicrogons,
    totalVaultValue,
  };
});
