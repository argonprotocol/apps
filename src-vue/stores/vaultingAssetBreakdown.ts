import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, BondLot, TreasuryBonds, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useWallets } from './wallets.ts';
import { getMyVault } from './vaults.ts';
import { getCurrency } from './currency.ts';
import { MyVault } from '../lib/MyVault.ts';
import { getBondMarket } from './myBonds.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const wallets = useWallets();
  const myVault = getMyVault();
  const bondMarket = getBondMarket();
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

  const vaultBondState = Vue.computed(() => {
    const vaultId = myVault.vaultId;
    return vaultId == null ? undefined : bondMarket.data.vaultsById[vaultId];
  });

  const treasuryBondTotals = Vue.computed(() => {
    return BondLot.getTotals(vaultBondState.value?.bondLots ?? []);
  });

  // What this vault owns now.
  const treasuryBondMicrogons = Vue.computed(() => {
    return treasuryBondTotals.value.totalBondMicrogons;
  });

  const treasuryActiveBondMicrogons = Vue.computed(() => {
    return treasuryBondTotals.value.activeBondMicrogons;
  });

  const treasuryReturningBondMicrogons = Vue.computed(() => {
    return treasuryBondTotals.value.returningBondMicrogons;
  });

  // What the vault can support with its active Bitcoin security.
  const treasuryBondCapacityMicrogons = Vue.computed(() => {
    const sats = BigInt(myVault.createdVault?.securitizedSatoshis ?? 0);
    if (sats <= 0n) return 0n;
    return currency.priceIndex.getBtcMicrogonPrice(sats);
  });

  const treasuryBondCapacityUsedMicrogons = Vue.computed(() => {
    return bigIntMin(treasuryActiveBondMicrogons.value, treasuryBondCapacityMicrogons.value);
  });

  const treasuryBondCapacityUsedPct = Vue.computed(() => {
    if (treasuryBondCapacityMicrogons.value <= 0n) return 0;
    return BigNumber(treasuryBondCapacityUsedMicrogons.value)
      .div(BigNumber(treasuryBondCapacityMicrogons.value))
      .multipliedBy(100)
      .toNumber();
  });

  const treasuryBondPurchaseCapacityBonds = Vue.computed(() => {
    return TreasuryBonds.getBondPurchaseCapacity(
      treasuryBondCapacityMicrogons.value,
      bondMarket.data.bondFullCapacityPerFrame,
    );
  });

  // The remaining next-frame room for buying new bonds.
  const treasuryBondMicrogonsAvailable = Vue.computed(() => {
    const availability = TreasuryBonds.calculateNextFrameBondAvailability(
      treasuryBondCapacityMicrogons.value,
      vaultBondState.value?.bondLots ?? [],
      bondMarket.data.bondFullCapacityPerFrame,
    );
    return BondLot.bondsToMicrogons(availability.nextFrameAvailableBonds);
  });

  // Operational Fees

  const operationalFeeMicrogons = Vue.computed(() => {
    return myVault.metadata?.operationalFeeMicrogons ?? 0n;
  });

  // Total Vault

  const totalVaultValue = Vue.computed(() => {
    return (
      sidelinedTotalValue.value + securityTotalValue.value + treasuryBondMicrogons.value - operationalFeeMicrogons.value
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

    treasuryBondMicrogons,
    treasuryActiveBondMicrogons,
    treasuryReturningBondMicrogons,
    treasuryBondCapacityMicrogons,
    treasuryBondCapacityUsedMicrogons,
    treasuryBondCapacityUsedPct,
    treasuryBondPurchaseCapacityBonds,
    treasuryBondMicrogonsAvailable,

    operationalFeeMicrogons,
    totalVaultValue,
  };
});
