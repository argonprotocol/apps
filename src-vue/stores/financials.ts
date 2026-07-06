import { defineStore } from 'pinia';
import * as Vue from 'vue';
import { useWallets } from './wallets.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';
import { useMyBonds } from './myBonds.ts';
import { calculatePerformanceReturn, IPerformanceReturnInput } from '../lib/PerformanceReturn.ts';
import { getMiningFrames } from './mainchain.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { bigIntMax, GlobalVaultingStats, UnitOfMeasurement } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { BitcoinLock, MICROGONS_PER_ARGON, Vault } from '@argonprotocol/mainchain';
import { getVaults } from './vaults.ts';
import type { IOtherToken } from '../lib/Wallet.ts';
import { IBitcoinLockProcessingDetails } from '../lib/BitcoinLocks.ts';

export interface ILockSummary {
  uuid: string;
  utxoId: number | undefined;
  status: BitcoinLockStatus;
  statusDetails: {
    hasObservedFundingSignal: boolean;
    showMismatchAccept: boolean;
    showFundingMismatch: boolean;
    showReadyForBitcoin: boolean;
    isFundingSeenInMempoolOnly: boolean;
  };
  lockProcessingDetails: IBitcoinLockProcessingDetails;
  lockProcessingError: string;
  satoshis: bigint;
  valueOfBtc: bigint;
  totalLiquidity: bigint;
  valueBeyondLiquidity: bigint;
  startingCapital: bigint;
  endingCapital: bigint;
  hodlingReturn: number;
  totalReturn: number;
  totalFees: bigint;
  unlockAmount: bigint;
  createdAt: Date;
  record: IBitcoinLockRecord;
}

export const useFinancials = defineStore('financials', () => {
  const wallets = useWallets();
  const myBonds = useMyBonds();
  const bitcoinLocks = getBitcoinLocks();
  const miningFrames = getMiningFrames();
  const currency = getCurrency();
  const vaultStore = getVaults();

  const stats = new GlobalVaultingStats(vaultStore, currency);

  const isLoaded = Vue.ref(false);

  // Vaults ////////////////////////////////////////////////////////////////////////////////////////////////////////////

  const vaultsActiveRecords = Vue.shallowRef<Vault[]>([]);
  const vaultsIsLoaded = Vue.ref(false);

  async function loadVaults() {
    try {
      await vaultStore.updateRevenue();

      vaultsActiveRecords.value = Object.values(vaultStore.vaultsById)
        .filter(vault => vault.availableSecuritization() > 0n)
        .sort((left, right) => {
          const leftAvailableBitcoinSpace = left.availableBitcoinSpace();
          const rightAvailableBitcoinSpace = right.availableBitcoinSpace();
          if (rightAvailableBitcoinSpace !== leftAvailableBitcoinSpace) {
            return rightAvailableBitcoinSpace > leftAvailableBitcoinSpace ? 1 : -1;
          }
          return left.vaultId - right.vaultId;
        });
    } catch (error) {
      console.error('Failed to load active vaults', error);
      vaultsActiveRecords.value = [];
    } finally {
      vaultsIsLoaded.value = true;
    }
  }

  // Savings ///////////////////////////////////////////////////////////////////////////////////////////////////////////

  const savingsTotalPending = Vue.computed(() => {
    const lockedRecords = liquidVisibleRecords.value.filter(x => {
      return [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(x.status);
    });
    return lockedRecords.reduce((sum, lock) => {
      const ratchets = lock.record.ratchets ?? [];
      return sum + ratchets.reduce((s, r) => s + (r.mintPending ?? 0n), 0n);
    }, 0n);
  });
  const savingsTotalReadyToUse = Vue.ref(0n);
  const savingsTotalValue = Vue.computed(() => {
    return savingsTotalPending.value + savingsTotalReadyToUse.value;
  });

  const savingsInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const savingsAllTimeFiatKey = Vue.ref(UnitOfMeasurement.USD);
  const savingsAllTimeReturn = Vue.ref(0);

  const savingsRestabilizationPower = Vue.ref(1);

  const savingsIsLoaded = Vue.ref(false);

  function loadSavings() {
    savingsTotalReadyToUse.value = wallets.defaultArgonWallet.availableMicrogons;

    const savingsReturnBn = BigNumber(currency.usdTarget - 1)
      .dividedBy(1)
      .multipliedBy(100);
    savingsAllTimeReturn.value = savingsReturnBn.toNumber();

    void stats.load().then(() => {
      const microgonValueInVaults = stats.microgonValueOfVaultedBitcoins;
      const microgonBurnCapacity = BigInt(Math.round(stats.argonBurnCapacity * MICROGONS_PER_ARGON));
      savingsRestabilizationPower.value = BigNumber(microgonBurnCapacity).dividedBy(microgonValueInVaults).toNumber();
    });

    savingsIsLoaded.value = true;
  }

  Vue.watch([wallets.defaultArgonWallet], () => {
    loadSavings();
  });

  // Argon Bonds ///////////////////////////////////////////////////////////////////////////////////////////////////////

  const bondsTotalValue = Vue.computed(() => {
    return myBonds.bondLots.reduce((sum, bondLot) => sum + bondLot.bondMicrogons, 0n);
  });
  const bondsTotalProfits = Vue.computed(() => {
    return myBonds.bondLots.reduce((sum, bondLot) => sum + bondLot.lifetimeEarnings, 0n);
  });

  const bondsInvestments = Vue.computed<IPerformanceReturnInput[]>(() => {
    return myBonds.bondLots.map(bondLot => {
      return {
        startingDate: miningFrames.getFrameDate(bondLot.createdFrame),
        startingCapital: bondLot.bondMicrogons,
        endingDate: new Date(),
        endingCapital: bondLot.bondMicrogons + bondLot.lifetimeEarnings,
        bondLot,
      };
    });
  });
  const bondsPerformanceReturn = Vue.computed(() => {
    return calculatePerformanceReturn(bondsInvestments.value).percent;
  });

  const bondsIsLoaded = Vue.computed(() => myBonds.isLoaded);

  // Bitcoin Liquid Locks ///////////////////////////////////////////////////////////////////////////////////////////////

  const lockedStatuses = [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted];

  const liquidAllRecords = Vue.ref<ILockSummary[]>([]);

  const liquidInvisibleRecords = Vue.computed<ILockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => bitcoinLocks.isInactiveForVaultDisplay(l.record));
  });

  const liquidVisibleRecords = Vue.computed<ILockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => !bitcoinLocks.isInactiveForVaultDisplay(l.record));
  });

  const liquidPrelockedRecords = Vue.computed<ILockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => {
      return (
        l.status == BitcoinLockStatus.LockIsProcessingOnArgon ||
        l.status === BitcoinLockStatus.LockPendingFunding ||
        l.status === BitcoinLockStatus.LockFailed
      );
    });
  });

  const liquidProblemRecords = Vue.computed(() => {
    return liquidVisibleRecords.value.filter(l => {
      return (
        l.status === BitcoinLockStatus.LockExpiredWaitingForFunding ||
        l.status === BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged ||
        l.status === BitcoinLockStatus.LockFundingReadyToResume ||
        l.status === BitcoinLockStatus.LockFailed ||
        l.statusDetails.showMismatchAccept ||
        l.statusDetails.showFundingMismatch
      );
    });
  });

  const liquidLockedRecords = Vue.computed(() => {
    return liquidVisibleRecords.value.filter(l => lockedStatuses.includes(l.status));
  });

  const liquidTotalSatoshis = Vue.computed(() => {
    return liquidLockedRecords.value.reduce((sum, l) => sum + l.satoshis, 0n);
  });

  const liquidInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const liquidPerformanceReturn = Vue.computed(() => {
    return calculatePerformanceReturn(liquidInvestments.value).percent;
  });

  const liquidHodlingInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const liquidHodlingReturn = Vue.computed(() => {
    return calculatePerformanceReturn(liquidHodlingInvestments.value).percent;
  });

  const liquidCurrentBitcoinDebt = Vue.ref(0n);
  let lockSummaryProgressInterval: ReturnType<typeof setInterval> | undefined;

  async function loadLocks() {
    const tmpHodlingInvestments: IPerformanceReturnInput[] = [];
    const tmpLiquidInvestments: IPerformanceReturnInput[] = [];
    const lockSummaries: ILockSummary[] = [];

    let currentBitcoinDebt = 0n;

    for (const lock of bitcoinLocks.getAllLocks()) {
      const summary = await convertLockRecordToSummary(lock);
      lockSummaries.push(summary);

      if (lockedStatuses.includes(summary.status)) {
        currentBitcoinDebt += summary.unlockAmount;
      }

      const investmentStatuses = [...lockedStatuses, BitcoinLockStatus.Releasing, BitcoinLockStatus.Released];
      if (investmentStatuses.includes(summary.status) && lock.ratchets[0]) {
        tmpHodlingInvestments.push({
          startingDate: lock.createdAt,
          startingCapital: summary.startingCapital,
          endingDate: new Date(),
          endingCapital: summary.valueOfBtc,
        });
        tmpLiquidInvestments.push({
          startingDate: lock.createdAt,
          startingCapital: summary.startingCapital,
          endingDate: new Date(),
          endingCapital: summary.endingCapital,
        });
      }
    }

    liquidCurrentBitcoinDebt.value = currentBitcoinDebt;
    liquidAllRecords.value = lockSummaries;
    liquidHodlingInvestments.value = tmpHodlingInvestments;
    liquidInvestments.value = tmpLiquidInvestments;
  }

  async function convertLockRecordToSummary(lock: IBitcoinLockRecord): Promise<ILockSummary> {
    const btc = currency.convertSatToBtc(lock.satoshis);
    const valueOfBtc = currency.convertBtcToMicrogon(btc);
    const grossFees = lock.ratchets.reduce((t, r) => t + r.txFee + r.securityFee, 0n);
    const totalFees = bigIntMax(grossFees - (lock.lockDetails?.couponFeesPaid ?? 0n), 0n);
    const totalLiquidity = lock.ratchets.reduce((t, r) => t + r.mintAmount, 0n);
    const startingCapital = lock.ratchets[0]?.lockedTargetPrice ?? lock.lockedTargetPrice;
    const liquidityPromised = lock.ratchets[0]?.mintAmount ?? lock.liquidityPromised;
    const availableRatchetLiquidity = bigIntMax(valueOfBtc - lock.lockedTargetPrice, 0n);
    const returnLiquidity = totalLiquidity + availableRatchetLiquidity;
    const valueBeyondLiquidity = availableRatchetLiquidity;
    const unlockAmount =
      BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, lock.satoshis, lock.lockedTargetPrice) ||
      0n;
    const endingCapital = startingCapital + returnLiquidity - unlockAmount - totalFees;

    const hodlingReturn = calculateBitcoinReturn(lock.lockedTargetPrice, valueOfBtc);
    const totalReturn = calculateBitcoinReturn(startingCapital, endingCapital);

    const mismatchView = bitcoinLocks.getMismatchViewState(lock);
    const lockProcessingDetails = bitcoinLocks.getLockProcessingDetails(lock);
    const lockProcessingError = bitcoinLocks.getLockProcessingError(lock);

    const hasObservedFundingSignal = bitcoinLocks.hasObservedFundingSignal(lock);
    const showMismatchAccept = mismatchView.phase === 'accepting';
    const showFundingMismatch = ['review', 'returningOnArgon', 'returningOnBitcoin', 'returned', 'error'].includes(
      mismatchView.phase,
    );
    const showReadyForBitcoin =
      !showFundingMismatch &&
      !showMismatchAccept &&
      !hasObservedFundingSignal &&
      lockProcessingDetails.confirmations < 0;
    const isFundingSeenInMempoolOnly = hasObservedFundingSignal && lockProcessingDetails.confirmations < 0;

    const lockSummary = Vue.reactive<ILockSummary>({
      uuid: lock.uuid,
      utxoId: lock.utxoId,
      status: lock.status,
      statusDetails: {
        hasObservedFundingSignal,
        showMismatchAccept,
        showFundingMismatch,
        showReadyForBitcoin,
        isFundingSeenInMempoolOnly,
      },
      lockProcessingDetails,
      lockProcessingError,
      satoshis: lock.satoshis,
      valueOfBtc: valueOfBtc,
      totalLiquidity,
      valueBeyondLiquidity,
      startingCapital: startingCapital,
      endingCapital: lock.ratchets[0] ? endingCapital : liquidityPromised,
      hodlingReturn: hodlingReturn,
      totalReturn: totalReturn,
      totalFees: totalFees,
      unlockAmount: unlockAmount,
      createdAt: lock.createdAt,
      record: lock,
    });

    return lockSummary as ILockSummary;
  }

  function refreshLockSummaryProgress() {
    for (const summary of liquidAllRecords.value) {
      const lock = summary.record;
      const mismatchView = bitcoinLocks.getMismatchViewState(lock);
      const lockProcessingDetails = bitcoinLocks.getLockProcessingDetails(lock);
      const hasObservedFundingSignal = bitcoinLocks.hasObservedFundingSignal(lock);
      const showMismatchAccept = mismatchView.phase === 'accepting';
      const showFundingMismatch = ['review', 'returningOnArgon', 'returningOnBitcoin', 'returned', 'error'].includes(
        mismatchView.phase,
      );

      summary.status = lock.status;
      summary.lockProcessingDetails = lockProcessingDetails;
      summary.lockProcessingError = bitcoinLocks.getLockProcessingError(lock);
      summary.statusDetails.hasObservedFundingSignal = hasObservedFundingSignal;
      summary.statusDetails.showMismatchAccept = showMismatchAccept;
      summary.statusDetails.showFundingMismatch = showFundingMismatch;
      summary.statusDetails.showReadyForBitcoin =
        !showFundingMismatch &&
        !showMismatchAccept &&
        !hasObservedFundingSignal &&
        lockProcessingDetails.confirmations < 0;
      summary.statusDetails.isFundingSeenInMempoolOnly =
        hasObservedFundingSignal && lockProcessingDetails.confirmations < 0;
    }
  }

  function startLockSummaryProgressRefresh() {
    if (lockSummaryProgressInterval) return;
    lockSummaryProgressInterval = setInterval(refreshLockSummaryProgress, 1_000);
  }

  function calculateBitcoinReturn(investment: bigint, currentValue: bigint): number {
    if (investment <= 0n) return 0;
    const earnings = currentValue - investment;
    const pctBn = BigNumber(earnings).dividedBy(investment);
    return pctBn.multipliedBy(100).toNumber();
  }

  Vue.watch(
    () => [bitcoinLocks.data.locksByUtxoId, bitcoinLocks.data.pendingLocks],
    () => {
      void loadLocks();
    },
    { deep: true },
  );

  Vue.watch(
    () => currency.priceIndex.btcUsdPrice?.toString(),
    () => {
      if (!isLoaded.value) return;
      void loadLocks();
    },
  );

  // Stable Swaps //////////////////////////////////////////////////////////////////////////////////////////////////////

  const swapsBelowTargetValue = Vue.computed(() => {
    const micronotValue = currency.convertMicronotTo(
      wallets.ethereumWallet.availableMicronots,
      UnitOfMeasurement.Microgon,
    );
    const otherTokenValue = wallets.ethereumWallet.otherTokens.reduce((totalValue, token) => {
      return totalValue + currency.convertOtherToMicrogon(token as IOtherToken);
    }, 0n);

    return micronotValue + otherTokenValue;
  });

  const swapsAboveTargetValue = Vue.computed(() => {
    return wallets.ethereumWallet.availableMicrogons;
  });

  const swapsTotalValue = Vue.computed(() => {
    return swapsBelowTargetValue.value + swapsAboveTargetValue.value;
  });

  const stableSwapInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const swapsPerformanceReturn = Vue.computed(() => {
    return calculatePerformanceReturn(stableSwapInvestments.value).percent;
  });

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  async function load() {
    await Promise.all([myBonds.load(), bitcoinLocks.load(), currency.fetchMainchainRates(), vaultStore.load()]);

    loadSavings();
    await Promise.all([loadVaults(), loadLocks()]);
    startLockSummaryProgressRefresh();

    isLoaded.value = true;
  }

  void load();

  const totalValue = Vue.computed(() => {
    const btc = currency.convertSatToBtc(liquidTotalSatoshis.value);
    const valueOfBtc = currency.convertBtcToMicrogon(btc);
    return savingsTotalValue.value + bondsTotalValue.value + valueOfBtc + swapsTotalValue.value;
  });

  const totalPerformanceReturn = Vue.computed(() => {
    const allInvestments: IPerformanceReturnInput[] = [
      ...savingsInvestments.value,
      ...bondsInvestments.value,
      ...liquidInvestments.value,
      ...stableSwapInvestments.value,
    ];
    return calculatePerformanceReturn(allInvestments).percent;
  });

  return {
    vaultsActiveRecords,
    vaultsIsLoaded,

    savingsTotalPending,
    savingsTotalReadyToUse,
    savingsTotalValue,
    savingsAllTimeFiatKey,
    savingsAllTimeReturn,
    savingsRestabilizationPower,
    savingsIsLoaded,

    bondsTotalValue,
    bondsTotalProfits,
    bondsPerformanceReturn,
    bondsIsLoaded,
    convertLockRecordToSummary,

    liquidAllRecords,
    liquidVisibleRecords,
    liquidInvisibleRecords,
    liquidProblemRecords,
    liquidPrelockedRecords,
    liquidLockedRecords,
    liquidTotalSatoshis,
    liquidCurrentBitcoinDebt,
    liquidPerformanceReturn,
    liquidHodlingReturn,

    swapsBelowTargetValue,
    swapsAboveTargetValue,
    swapsTotalValue,
    swapsPerformanceReturn,

    totalValue,
    totalPerformanceReturn,
  };
});
