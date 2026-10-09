import * as Vue from 'vue';
import { defineStore } from 'pinia';
import BigNumber from 'bignumber.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt, BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
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

  const bitcoinFundingShortfallMicrogons = Vue.computed(() => {
    if (bitcoinRequiredSecuritizationMicrogons.value === undefined) return 0n;
    return bigIntMax(
      0n,
      bitcoinRequiredSecuritizationMicrogons.value - (myVault.createdVault?.securitizationTarget ?? 0n),
    );
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
    bitcoinLockedValueMicrogons,
    bitcoinRequiredSecuritizationMicrogons,
    bitcoinUndersecuritized,
    bitcoinFundingShortfallMicrogons,

    treasuryBondCapacityMicrogons,
    treasuryBondCapacityUsedMicrogons,
    treasuryBondCapacityUsedPct,
    treasuryBondPurchaseCapacityBonds,

    revenueCapturedPct,
    revenuePotential,
    argonotRewardBacking,
  };
});

/** Keep liquid collateral, then fill the remaining chart space with the largest Bitcoin locks. */
export function allocateBitcoinVaultSpace(
  locks: readonly Pick<
    IBitcoinLockRecord,
    'lockId' | 'fundedSatoshis' | 'fissionedSatoshis' | 'securitizationCoverageMicrogons' | 'securitizationRatio'
  >[],
  securitization: bigint,
  price: PriceIndex,
) {
  const allocations = new Map<(typeof locks)[number], { allocatedMicrogons: bigint; requiredMicrogons: bigint }>();
  let liquidTotal = 0n;

  for (const lock of locks) {
    const collateral = bigNumberToBigInt(
      BigNumber(lock.securitizationCoverageMicrogons ?? 0n).times(lock.securitizationRatio ?? 1),
    );
    // Liquids and unfunded locks use their reserved collateral; ordinary funded locks use Bitcoin value.
    let amount = collateral;
    const isLiquid = (lock.fissionedSatoshis ?? 0n) > 0n;
    if (!isLiquid && lock.fundedSatoshis > 0n && price.btcUsdPrice?.gt(0) && price.argonUsdPrice?.gt(0)) {
      amount = price.getSatoshiPriceInMarketMicrogons(lock.fundedSatoshis);
    }
    allocations.set(lock, { allocatedMicrogons: amount, requiredMicrogons: amount });
    if (isLiquid) liquidTotal += amount;
  }

  // Keep every liquid visible, scaling only if their combined collateral exceeds the whole vault.
  const available = bigIntMax(0n, securitization);
  const liquidSpace = bigIntMin(liquidTotal, available);
  if (liquidTotal > liquidSpace) {
    for (const [lock, allocation] of allocations) {
      if ((lock.fissionedSatoshis ?? 0n) === 0n) continue;
      allocation.allocatedMicrogons = (allocation.requiredMicrogons * liquidSpace) / liquidTotal;
    }
  }

  const ordinaryLocks = [...allocations].filter(([lock]) => (lock.fissionedSatoshis ?? 0n) === 0n);
  ordinaryLocks.sort(([a, aAllocation], [b, bAllocation]) => {
    if (aAllocation.requiredMicrogons > bAllocation.requiredMicrogons) return -1;
    if (aAllocation.requiredMicrogons < bAllocation.requiredMicrogons) return 1;
    return (a.lockId ?? 0) - (b.lockId ?? 0);
  });

  let remaining = available - liquidSpace;
  for (const [, allocation] of ordinaryLocks) {
    allocation.allocatedMicrogons = bigIntMin(allocation.requiredMicrogons, remaining);
    remaining -= allocation.allocatedMicrogons;
  }
  return allocations;
}
