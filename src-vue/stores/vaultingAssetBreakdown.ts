import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMin, BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import { getMyVault } from './vaults.ts';
import { getArgonBonds } from './argonBonds.ts';
import { getCurrency } from './currency.ts';
import { getCappedPercent } from '../lib/Utils.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const myVault = getMyVault();
  const argonBonds = getArgonBonds();
  const currency = getCurrency();

  // Security

  const securityMicrogons = Vue.computed(() => {
    return myVault.createdVault?.securitization ?? 0n;
  });

  const securityMicrogonsPending = Vue.computed(() => {
    return myVault.createdVault?.securitizationPendingActivation ?? 0n;
  });

  const securityMicrogonsActivated = Vue.computed<bigint>(() => {
    return myVault.createdVault?.activatedSecuritization() ?? 0n;
  });

  const securityMicrogonsActivatedPct = Vue.computed<number>(() => {
    if (securityMicrogons.value <= 0n) return 0;

    const pctBn = BigNumber(securityMicrogonsActivated.value).div(securityMicrogons.value);
    return pctBn.multipliedBy(100).toNumber();
  });

  const bitcoinLockedValueMicrogons = Vue.computed(() => {
    const vault = myVault.createdVault;
    if (!vault) return;
    const price = currency.priceIndex;
    if (!price.btcUsdPrice?.gt(0) || !price.argonUsdTargetPrice?.gt(0)) return;

    return currency.convertSatToMicrogon(vault.totalSatoshis);
  });

  const bitcoinRequiredSecuritizationMicrogons = Vue.computed(() => {
    const vault = myVault.createdVault;
    if (!vault) return;
    const price = currency.priceIndex;
    if (!price.btcUsdPrice?.gt(0) || !price.argonUsdPrice?.gt(0)) return;

    return price.getSatoshiPriceInMarketMicrogons(vault.totalSatoshis);
  });

  const bitcoinUndersecuritized = Vue.computed(() => {
    if (bitcoinRequiredSecuritizationMicrogons.value === undefined) return false;
    const shortfall = bitcoinRequiredSecuritizationMicrogons.value - securityMicrogons.value;
    if (shortfall <= 0n) return false;
    return shortfall * 100n >= securityMicrogons.value;
  });

  const securityMicronots = Vue.computed(() => myVault.data.argonotCommitment.heldMicronots);

  // Treasury

  const vaultBondState = Vue.computed(() => {
    const vaultId = myVault.vaultId;
    return vaultId == null ? undefined : argonBonds.data.vaultsById[vaultId];
  });

  const treasuryBondTotals = Vue.computed(() => {
    return BondLot.getTotals(vaultBondState.value?.bondLots ?? []);
  });

  // The bond capacity supported by this vault.
  const treasuryBondCapacityMicrogons = Vue.computed(() => {
    if (!myVault.createdVault) return 0n;

    return argonBonds.getVaultBondCapacityMicrogons(myVault.createdVault);
  });

  const treasuryBondCapacityUsedMicrogons = Vue.computed(() => {
    return bigIntMin(treasuryBondTotals.value.activeBondMicrogons, treasuryBondCapacityMicrogons.value);
  });

  const treasuryBondCapacityUsedPct = Vue.computed(() => {
    if (treasuryBondCapacityMicrogons.value <= 0n) return 0;
    return BigNumber(treasuryBondCapacityUsedMicrogons.value)
      .div(BigNumber(treasuryBondCapacityMicrogons.value))
      .multipliedBy(100)
      .toNumber();
  });

  const treasuryBondPurchaseCapacityBonds = Vue.computed(() => {
    return TreasuryBonds.getBondPurchaseCapacity(treasuryBondCapacityMicrogons.value);
  });

  const revenuePotential = Vue.computed(() => {
    const vault = myVault.createdVault;
    return vault ? argonBonds.vaultRevenuePotential(vault.vaultId) : undefined;
  });

  const argonotRewardBacking = Vue.computed(() => {
    const vault = myVault.createdVault;
    if (!vault || !argonBonds.data.frameCapital?.vaultSecuritizationPositions[vault.vaultId]) return;
    return argonBonds.argonotRewardBacking({ vault, argonotSecuritization: myVault.data.argonotCommitment });
  });

  const revenueCapturedPct = Vue.computed(() => {
    if (argonBonds.data.frameCapital) return revenuePotential.value?.capturedPercent;
    const currentBonds = vaultBondState.value?.currentFrame.vaultBonds ?? 0;
    return getCappedPercent(currentBonds, treasuryBondPurchaseCapacityBonds.value);
  });

  return {
    securityMicrogons,
    securityMicronots,
    securityMicrogonsPending,
    securityMicrogonsActivated,
    securityMicrogonsActivatedPct,
    bitcoinLockedValueMicrogons,
    bitcoinRequiredSecuritizationMicrogons,
    bitcoinUndersecuritized,

    treasuryBondCapacityMicrogons,
    treasuryBondCapacityUsedMicrogons,
    treasuryBondCapacityUsedPct,
    treasuryBondPurchaseCapacityBonds,

    revenueCapturedPct,
    revenuePotential,
    argonotRewardBacking,
  };
});
