import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { bigIntMax, bigNumberToBigInt } from '@argonprotocol/apps-core';
import { MyVault } from '../lib/MyVault.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { getWalletKeys, useWallets } from './wallets.ts';
import { getMyVault, getVaults } from './vaults.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';

export const useVaultingAssetBreakdown = defineStore('vaultingAssetBreakdown', () => {
  const wallets = useWallets();
  const myVault = getMyVault();
  const bitcoinLocks = getBitcoinLocks();
  const currency = getCurrency();
  const vaults = getVaults();

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
    const vault = myVault.createdVault;
    if (!vault) return 0n;
    const securitization = vault.securitization;
    const everActivatedSecuritization = bigNumberToBigInt(vault.securitizationRatioBN().times(vault.argonsLocked));
    return securitization - everActivatedSecuritization;
  });

  const hasLockedBitcoin = Vue.computed(() => {
    return [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(
      personalLock.value?.status as any,
    );
  });

  const activatedSecuritization = Vue.computed(() => {
    // TODO: this value is wrong when there are pending activations and relocks
    return myVault.createdVault?.activatedSecuritization() ?? 0n;
  });

  const pendingSecuritization = Vue.computed(() => {
    const vault = myVault.createdVault;
    if (!vault) return 0n;
    return bigNumberToBigInt(vault.securitizationRatioBN().times(vault.argonsPendingActivation));
  });

  const sidelinedMicrogons = Vue.computed(() => {
    return bigIntMax(wallets.vaultingWallet.availableMicrogons - MyVault.OperationalReserves, 0n);
  });

  const internalTreasuryPoolBonds = Vue.computed(() => {
    const revenue = myVault.data.stats;
    if (!revenue) return 0n;
    return (
      myVault.data.prebondedMicrogons +
      revenue.changesByFrame
        .slice(0, 10)
        .filter(x => x.frameId >= myVault.data.currentFrameId - 10)
        .reduce((acc, change) => acc + (change.treasuryPool.vaultCapital ?? 0n), 0n)
    );
  });

  const activatedTreasuryPoolInvestment = Vue.computed(() => {
    return internalTreasuryPoolBonds.value;
  });

  const pendingTreasuryPoolInvestment = Vue.computed(() => {
    return bigIntMax(
      0n,
      internalTreasuryPoolBonds.value - ((myVault.createdVault?.securitization ?? 0n) - waitingSecuritization.value),
    );
  });

  const totalVaultValue = Vue.computed(() => {
    return (
      wallets.totalVaultingResources +
      pendingMintingValue.value -
      myVault.data.pendingCollectRevenue -
      unlockPrice.value
    );
  });

  const bitcoinSecurityTotal = Vue.computed(() => {
    return myVault.createdVault?.securitization ?? 0n;
  });

  const pendingMintingValue = Vue.computed<bigint>(() => {
    return bitcoinLocks.totalMintPending;
  });

  const mintedValueInAccount = Vue.computed(() => {
    return bitcoinLocks.totalMinted - (myVault.metadata?.personalBitcoinMintAmountMovedOut ?? 0n);
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
    const vaultingAddress = getWalletKeys().vaultingAddress;
    const unlockFee = await bitcoinLocks.estimatedReleaseArgonTxFee({ lock: lock, vaultingAddress }).catch(() => 0n);
    unlockPrice.value = (await vaults.getRedemptionRate(lock).catch(() => 0n)) + unlockFee;
  }

  Vue.watch(
    currency.priceIndex,
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
    mintedValueInAccount,
    pendingAllocateTxMetadata,
    sidelinedMicrogons,
    bitcoinSecurityTotal,
    waitingSecuritization: waitingSecuritization,
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
