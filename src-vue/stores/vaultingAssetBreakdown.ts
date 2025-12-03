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

  const alreadyMintedValue = Vue.computed(() => {
    return bitcoinLocks.totalMinted;
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

  const help = Vue.computed(() => {
    return {
      vaultingAvailableMicrogons: `<p class="break-words whitespace-normal">These argons are not currently being used.</p>`,
      pendingMintingValue: pendingMintingValue.value
        ? `<p class="break-words whitespace-normal">
          These have been earned, but they have not yet been minted. Minting is determined by supply and demand,
          which means, although you're guaranteed to get them, the timeframe is unknown.
        </p>`
        : `<p class="break-words whitespace-normal">
          This is where you'll see argons that are earned but not yet minted. You currently have zero argons waiting
          in the minting queue.
        </p>`,
      alreadyMintedValue: pendingAllocateTxMetadata.value
        ? `<p class="break-words whitespace-normal">
              These argons are available for use. Click the Activate button to distribute them between bitcoin
              securitization and treasury bonds.
            </p>`
        : `<p class="break-words whitespace-normal">
              These argons are currently being activated. Once the activation transaction is finalized, they will be
              distributed between bitcoin securitization and treasury bonds.
            </p>`,
      bitcoinSecurityTotal: `<p class="break-words whitespace-normal">
            This is the total capital applied to your vault's bitcoin securitization. It insures that anyone who locks
            bitcoin in your vault will be able to claim their bitcoin back in full.
          </p>`,
      waitingSecuritization: `<p class="break-words whitespace-normal">
              These argons have not yet been applied to your vault's securitization. They are waiting for new bitcoins
              to be added to your vault.
            </p>`,
      pendingSecuritization: `<p class="break-words whitespace-normal">
              These argons are already committed to bitcoins pending in your vault. However, these bitcoins are still in
              the process of locking. Once completed, these argons will move to "Actively In Use".
            </p>`,
      activatedSecuritization: activatedSecuritization.value
        ? `<p v-if="breakdown.activatedSecuritization" class="break-words whitespace-normal">
              These argons are currently being used to securitize your vault's bitcoin.
            </p>`
        : `<p v-else class="break-words whitespace-normal">
              You have no argons actively being used to securitize bitcoins.
            </p>`,
      treasuryBondTotal: `<p class="break-words whitespace-normal">
            This is the capital that has been allocated to your vault's treasury bonds.
          </p>`,
      pendingTreasuryPoolInvestment: `<p class="break-words whitespace-normal">
              This capital is sitting idle because your vault does not have enough bitcoin. The amount in treasury bonds
              cannot exceed the bitcoin value in your vault.
            </p>`,
      activatedTreasuryPoolInvestment: activatedTreasuryPoolInvestment.value
        ? `<p class="break-words whitespace-normal">
              These argons are actively generating yield for your vault through treasury bond investments.
            </p>`
        : `<p v-else class="break-words whitespace-normal">
              You have no argons actively being applied to treasury bond investments.
            </p>`,
      unlockPrice: `<p class="break-words whitespace-normal">This is what it will cost to unlock your personal bitcoin.</p>`,
      operationalFeeMicrogons: `<p class="break-words whitespace-normal">
            The summation of all operational expenses that have been paid since your vault's inception.
          </p>`,
      totalVaultValue: `<p class="font-normal break-words whitespace-normal">The total value of your vault's assets.</p>`,
    };
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
    alreadyMintedValue,
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
    help,
  };
});
