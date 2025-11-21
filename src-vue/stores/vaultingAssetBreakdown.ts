import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { bigIntMax } from '@argonprotocol/apps-core';
import { MyVault } from '../lib/MyVault.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { useWalletKeys, useWallets } from './wallets.ts';
import { useMyVault, useVaults } from './vaults.ts';
import { useBitcoinLocks } from './bitcoin.ts';
import { useCurrency } from './currency.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const wallets = useWallets();
  const myVault = useMyVault();
  const bitcoinLocks = useBitcoinLocks();
  const currency = useCurrency();
  const vaults = useVaults();

  const unlockPrice = Vue.ref(0n);

  const personalLock = Vue.computed(() => {
    if (bitcoinLocks.data.pendingLock) {
      return bitcoinLocks.data.pendingLock;
    }
    const utxoId = myVault.metadata?.personalUtxoId;
    if (utxoId) {
      return bitcoinLocks.data.locksByUtxoId[utxoId];
    }
  });

  const waitingSecuritization = Vue.computed(() => {
    const securitization = myVault.createdVault?.securitization ?? 0n;
    return securitization - (activatedSecuritization.value + pendingSecuritization.value);
  });

  const hasLockedBitcoin = Vue.computed(() => {
    return [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(
      personalLock.value?.status as any,
    );
  });

  const activatedSecuritization = Vue.computed(() => {
    return myVault.createdVault?.activatedSecuritization() ?? 0n;
  });

  const pendingSecuritization = Vue.computed(() => {
    return myVault.createdVault?.argonsPendingActivation ?? 0n;
  });

  const sidelinedMicrogons = Vue.computed(() => {
    return bigIntMax(wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves, 0n);
  });

  const operationalMicrogons = Vue.computed(() => {
    if (wallets.vaultingWallet.availableMicrogons < MyVault.OperationalReserves)
      return wallets.vaultingWallet.availableMicrogons;
    return MyVault.OperationalReserves;
  });

  const internalTreasuryPoolBonds = Vue.computed(() => {
    const revenue = myVault.data.stats;
    if (!revenue) return 0n;
    return revenue.changesByFrame
      .slice(0, 10)
      .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
      .reduce((acc, change) => acc + (change.treasuryPool.vaultCapital ?? 0n), 0n);
  });

  const activatedTreasuryPoolInvestment = Vue.computed(() => {
    return internalTreasuryPoolBonds.value;
  });

  const pendingTreasuryPoolInvestment = Vue.computed(() => {
    return myVault.data.prebondedMicrogons ?? 0n;
  });

  const totalVaultValue = Vue.computed(() => {
    return (
      wallets.totalVaultingResources -
      (unlockPrice.value + myVault.data.pendingCollectRevenue + pendingMintingValue.value)
    );
  });

  const bitcoinSecurityTotal = Vue.computed(() => {
    return activatedSecuritization.value + pendingSecuritization.value + waitingSecuritization.value;
  });

  const pendingMintingValue = Vue.computed<bigint>(() => {
    return bitcoinLocks.totalMintPending;
  });

  const vaultingAvailableMicrogons = Vue.computed(() => {
    return wallets.vaultingWallet.availableMicrogons;
  });

  const pendingAllocateTxMetadata = Vue.computed(() => {
    return myVault.data.pendingAllocateTxInfo?.tx.metadataJson;
  });

  const treasuryBondTotal = Vue.computed(() => {
    return activatedTreasuryPoolInvestment.value + pendingTreasuryPoolInvestment.value;
  });

  const operationalFeeMicrogons = Vue.computed(() => {
    return myVault.metadata?.operationalFeeMicrogons ?? 0n;
  });

  async function updateBitcoinUnlockPrices() {
    const lock = personalLock.value;
    if (!lock) return;

    if (lock.status !== BitcoinLockStatus.LockedAndIsMinting && lock.status !== BitcoinLockStatus.LockedAndMinted) {
      unlockPrice.value = 0n;
      return;
    }
    const vaultingAddress = useWalletKeys().vaultingAddress;
    const unlockFee = await bitcoinLocks.estimatedReleaseArgonTxFee({ lock: lock, vaultingAddress }).catch(() => 0n);
    unlockPrice.value = (await vaults.getRedemptionRate(lock).catch(() => 0n)) + unlockFee;
  }

  Vue.watch(
    currency.priceIndex.current,
    () => {
      void updateBitcoinUnlockPrices();
    },
    { deep: true },
  );

  Vue.watch(
    personalLock,
    () => {
      void updateBitcoinUnlockPrices();
    },
    { deep: true },
  );

  void updateBitcoinUnlockPrices();

  return {
    vaultingAvailableMicrogons,
    pendingMintingValue,
    pendingAllocateTxMetadata,
    sidelinedMicrogons,
    bitcoinSecurityTotal,
    waitingSecuritization,
    pendingSecuritization,
    activatedSecuritization,
    treasuryBondTotal,
    pendingTreasuryPoolInvestment,
    activatedTreasuryPoolInvestment,
    hasLockedBitcoin,
    unlockPrice,
    operationalFeeMicrogons,
    totalVaultValue,
  };
});
