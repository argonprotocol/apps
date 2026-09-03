import { defineStore } from 'pinia';
import * as Vue from 'vue';
import { getWalletHistoryRecovery, getWalletsForArgon, useWallets } from './wallets.ts';
import { getBitcoinFissions, getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';
import { getArgonBonds } from './argonBonds.ts';
import { getBlockWatch } from './mainchain.ts';
import {
  calculateRestabilizationLeverage,
  calculatePerformanceReturn,
  type IBlockHeaderInfo,
  type Vault,
  type IPerformanceReturnInput,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';

import { getVaults, getMyVault } from './vaults.ts';
import { financialGroups, type IFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { calculatePositionReturn, FinancialPositionBook, reduceFinancialPositions } from '../lib/financials';
import {
  BitcoinFinancials,
  calculateBitcoinEndingCapital,
  calculateBitcoinReturn,
  valueSatoshisAtRate,
} from '../lib/financials/BitcoinLocks.ts';
import type { IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import { VaultFinancials } from '../lib/financials/MyVault.ts';
import type { IArgonAccountSnapshot } from '../lib/WalletsForArgon.ts';
import { StableSwapFinancials } from '../lib/financials/StableSwaps.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import { MiningFinancials } from '../lib/financials/MyMiningSeats.ts';
import type { MyMiningSeats } from '../lib/MyMiningSeats.ts';
import { useVaultingStats } from './vaultingStats.ts';
import { getConfig } from './config.ts';
import { useStableSwaps } from './stableSwaps.ts';
import { logStartupTiming } from '../lib/Utils.ts';

const mainchainFinancialGroups = ['liquid', 'mining', 'vaulting', 'bonds', 'bitcoin'] as const;

export const useFinancials = defineStore('financials', () => {
  const wallets = useWallets();
  const walletsForArgon = getWalletsForArgon();
  const argonBonds = getArgonBonds();
  const bitcoinLocks = getBitcoinLocks();
  const bitcoinFissions = getBitcoinFissions();
  const currency = getCurrency();
  const config = getConfig();
  const vaultStore = getVaults();
  const myVault = getMyVault();
  const stableSwaps = useStableSwaps();
  const walletFinancials = new WalletFinancials(walletsForArgon);
  const bondFinancials = new ArgonBondsFinancials(argonBonds);
  const bitcoinFinancials = new BitcoinFinancials(bitcoinLocks, bitcoinFissions, getDbPromise());
  const vaultFinancials = new VaultFinancials(myVault);
  const stableSwapFinancials = new StableSwapFinancials(stableSwaps);
  let myMiningSeats: ReturnType<typeof getMyMiningSeats> | undefined;
  let miningFinancials: MiningFinancials | undefined;
  let vaultingStats: ReturnType<typeof useVaultingStats> | undefined;
  const microgonsInCirculation = Vue.ref(0n);

  const isLoaded = Vue.ref(false);
  const financialPositionBook = Vue.shallowReactive(new FinancialPositionBook());
  const financialPositionAggregate = Vue.computed(() => {
    void financialPositionBook.revision;
    return reduceFinancialPositions(financialPositionBook.snapshots);
  });
  const accountSnapshot = Vue.shallowRef<IArgonAccountSnapshot>();
  const liquidNativeBalances = Vue.computed(() => {
    let microgons = 0n;
    let micronots = 0n;

    for (const position of financialPositionAggregate.value.groupSummaries.liquid.positions) {
      if (position.kind !== 'wallet-balance' && position.kind !== 'wallet-holding') continue;
      if (position.kind === 'wallet-holding') {
        if (position.lifecycle === 'active') micronots += position.nativeAmount;
        continue;
      }
      if (position.lifecycle === 'unavailable' || position.nativeAmount === undefined) continue;

      if (position.asset === 'ARGN') microgons += position.nativeAmount;
      if (position.asset === 'ARGNOT') micronots += position.nativeAmount;
    }

    return { microgons, micronots };
  });
  let queuedAccountHeader: IBlockHeaderInfo | undefined;
  let queuedAccountReconciliation = false;
  let activeAccountHash = '';
  let accountRefreshPromise: Promise<void> | undefined;
  let accountSourcesAreLoaded = false;
  let accountRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let accountRefreshRetryAttempts = 0;
  let lastCoveredWalletSnapshotBlock = 0;
  let lastPublishedArgonotCustodyRevision = 0;
  let queuedWalletHistoryBlock = 0;
  let queuedArgonotCustodyRevision = 0;
  let walletHistoryCoverage: { blockNumber: number; promise: Promise<boolean> } | undefined;
  let walletHistoryRefreshPromise: Promise<void> | undefined;
  Vue.onScopeDispose(() => {
    resetAccountRefreshRetry();
  });

  function publishEthereumWallet(): void {
    if (!wallets.ethereumWallets.length) {
      financialPositionBook.publish(financialPositionBook.beginRefresh('ethereum'), [], { observedAt: new Date() });
      return;
    }
    if (
      wallets.ethereumWallets.persistedWallets.some(
        wallet => !wallet.data.balanceUpdatedAt && !wallet.data.fetchErrorMsg,
      )
    )
      return;

    const refresh = financialPositionBook.beginRefresh('ethereum');
    const positions: IFinancialPosition[] = [...wallets.ethereumFinancialPositions];

    // if (config.hasActivatedStableSwaps && !wallets.ethereumWallet.fetchErrorMsg) {
    //   const [stableSwapPosition] = stableSwapFinancials.createFinancialPositions({
    //     wallet: wallets.ethereumWallet,
    //     walletSnapshot: stableSwaps.walletSnapshot,
    //     currentPriceMicrogons: stableSwaps.marketSnapshot?.currentPriceMicrogons,
    //   });
    //   if (stableSwapPosition?.currentValue !== undefined) {
    //     const argonPositionIndex = positions.findIndex(position => position.id === stableSwapPosition.id);
    //     if (argonPositionIndex === -1) positions.push(stableSwapPosition);
    //     else positions[argonPositionIndex] = stableSwapPosition;
    //   }
    // }

    financialPositionBook.publish(refresh, positions, {
      observedAt: new Date(),
    });
    if (wallets.ethereumWallets.persistedWallets.some(wallet => wallet.data.balanceIsCached)) {
      financialPositionBook.fail(refresh, 'Refreshing cached Ethereum balances');
    }
  }

  function publishEmptyBaseGroup(): void {
    const refresh = financialPositionBook.beginRefresh('base');
    financialPositionBook.publish(refresh, [], { observedAt: new Date() });
  }

  function getMyMiningSeatsSource() {
    return (myMiningSeats ??= getMyMiningSeats());
  }

  function getMiningFinancialsSource() {
    return (miningFinancials ??= new MiningFinancials(getMyMiningSeatsSource() as MyMiningSeats));
  }

  function getVaultingStatsSource() {
    return (vaultingStats ??= useVaultingStats());
  }

  function hasWalletHistoryCoverage(blockNumber: number): Promise<boolean> {
    if (walletHistoryCoverage?.blockNumber === blockNumber) return walletHistoryCoverage.promise;

    const promise = getWalletHistoryRecovery()
      .hasCompleteCoverage(blockNumber)
      .then(hasCoverage => {
        if (hasCoverage) lastCoveredWalletSnapshotBlock = Math.max(lastCoveredWalletSnapshotBlock, blockNumber);
        return hasCoverage;
      });
    walletHistoryCoverage = { blockNumber, promise };
    void promise.catch(() => {
      if (walletHistoryCoverage?.promise === promise) walletHistoryCoverage = undefined;
    });
    return promise;
  }

  async function prepareWalletPositions({
    snapshot,
    treasuryHoldsAreClaimed,
    miningClaimsHolds,
    vaultClaimsHolds,
  }: {
    snapshot: IArgonAccountSnapshot;
    treasuryHoldsAreClaimed: boolean;
    miningClaimsHolds: boolean;
    vaultClaimsHolds: boolean;
  }) {
    const historyCutoff = getBlockWatch().finalizedBlockHeader.blockNumber;
    const hasConfirmedHistoryCoverage = await hasWalletHistoryCoverage(historyCutoff);
    const accounts = config.hasExtensionOperations
      ? snapshot.accounts.filter(account => account.address !== wallets.miningBotWallet.address)
      : snapshot.accounts;

    return walletFinancials.loadPositions({
      ...snapshot,
      accounts,
      claimedHolds: {
        treasury: treasuryHoldsAreClaimed,
        miningSlot: miningClaimsHolds,
        vaults: vaultClaimsHolds,
      },
      claimedMicronotsByAccount: vaultClaimsHolds
        ? new Map([[wallets.defaultArgonWallet.address, myVault.data.argonotCommitment.committedMicronots]])
        : undefined,
      liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
      hasConfirmedHistoryCoverage,
    });
  }

  async function prepareBondPositions(snapshot: IArgonAccountSnapshot) {
    if (!config.hasExtensionTreasury) {
      return { positions: [], claimsHolds: false };
    }
    if (!argonBonds.data.isLoaded) return;

    const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
    if (!account) throw new Error('Default Argon account is missing from the wallet snapshot');

    const positions = await bondFinancials.loadPositions({
      account,
      liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
      ownedVaultId: myVault.createdVault?.vaultId,
    });
    return { positions, claimsHolds: true };
  }

  async function prepareMiningPositions(snapshot: IArgonAccountSnapshot) {
    if (!config.hasExtensionOperations) {
      return { positions: [], claimsHolds: false };
    }
    if (!getMyMiningSeatsSource().isLoaded) return;

    const historyCutoff = getBlockWatch().finalizedBlockHeader.blockNumber;
    const hasConfirmedHistoryCoverage = await hasWalletHistoryCoverage(historyCutoff);
    const positions = await getMiningFinancialsSource().loadPositions({
      accounts: snapshot.accounts,
      miningBotAddress: wallets.miningBotWallet.address,
      hasConfirmedHistoryCoverage,
    });

    return { positions, claimsHolds: true };
  }

  async function prepareVaultPositions(snapshot: IArgonAccountSnapshot) {
    if (!config.hasExtensionOperations) return { positions: [], claimsHolds: false };
    if (!myVault.data.isLoaded) return;

    const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
    if (!account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');

    const positions = await vaultFinancials.loadPositions({
      account,
      liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
    });
    return { positions, claimsHolds: Boolean(myVault.createdVault) };
  }

  async function refreshAccountSnapshot(header: IBlockHeaderInfo, force = false): Promise<void> {
    let refreshes: ReturnType<FinancialPositionBook['beginRefresh']>[] = [];

    try {
      const bestHeader = getBlockWatch().bestBlockHeader;
      if (!isSameBlock(header, bestHeader)) header = bestHeader;

      const clientAt = await getBlockWatch().getApi(header);
      let candidate = accountSnapshot.value;
      if (!candidate || candidate.observation.blockHash !== header.blockHash || force) {
        candidate = await walletsForArgon.readAccountSnapshot({
          api: clientAt,
          header,
          includeHolds: config.hasExtensionTreasury || config.hasExtensionOperations,
        });
      }
      if (!isOnCurrentBestChain(header)) {
        void queueAccountRefresh({ force: true });
        return;
      }

      const [miningResult, vaultingResult, bondsResult, bitcoinResult] = await Promise.allSettled([
        prepareMiningPositions(candidate),
        prepareVaultPositions(candidate),
        prepareBondPositions(candidate),
        prepareBitcoinPositions(candidate, header),
      ]);
      const currentGroups = financialPositionAggregate.value.groupSummaries;
      const [liquidResult] = await Promise.allSettled([
        prepareWalletPositions({
          snapshot: candidate,
          treasuryHoldsAreClaimed:
            bondsResult.status === 'fulfilled' && bondsResult.value
              ? bondsResult.value.claimsHolds
              : currentGroups.bonds.positions.length > 0,
          miningClaimsHolds:
            miningResult.status === 'fulfilled' && miningResult.value
              ? miningResult.value.claimsHolds
              : currentGroups.mining.positions.length > 0,
          vaultClaimsHolds:
            vaultingResult.status === 'fulfilled' && vaultingResult.value
              ? vaultingResult.value.claimsHolds
              : currentGroups.vaulting.positions.length > 0,
        }),
      ]);
      if (!isOnCurrentBestChain(header)) {
        void queueAccountRefresh({ force: true });
        return;
      }

      refreshes = mainchainFinancialGroups.map(group => financialPositionBook.beginRefresh(group));
      const [liquidRefresh, miningRefresh, vaultingRefresh, bondsRefresh, bitcoinRefresh] = refreshes;
      const updates: Parameters<FinancialPositionBook['commit']>[0][number][] = [];
      if (liquidResult.status === 'fulfilled') {
        updates.push({ refresh: liquidRefresh, positions: liquidResult.value, observation: candidate.observation });
      }
      if (miningResult.status === 'fulfilled' && miningResult.value) {
        updates.push({
          refresh: miningRefresh,
          positions: miningResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (vaultingResult.status === 'fulfilled' && vaultingResult.value) {
        updates.push({
          refresh: vaultingRefresh,
          positions: vaultingResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (bondsResult.status === 'fulfilled' && bondsResult.value) {
        updates.push({
          refresh: bondsRefresh,
          positions: bondsResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (bitcoinResult.status === 'fulfilled' && bitcoinResult.value) {
        updates.push({
          refresh: bitcoinRefresh,
          positions: bitcoinResult.value.positions,
          observation: bitcoinResult.value.observation,
          requiredObservation: candidate.observation,
        });
      }
      const didCommit = updates.length === 0 || financialPositionBook.commit(updates);
      if (didCommit) {
        accountSnapshot.value = candidate;
        if (bitcoinResult.status === 'fulfilled' && bitcoinResult.value) {
          liquidAllRecords.value = bitcoinResult.value.summaries;
          liquidHodlingInvestments.value = bitcoinResult.value.hodlingInvestments;
          liquidCurrentBitcoinDebt.value = bitcoinResult.value.currentBitcoinDebt;
        }

        const results = [
          { refresh: liquidRefresh, result: liquidResult, fallback: 'Unable to refresh wallet balances' },
          { refresh: miningRefresh, result: miningResult, fallback: 'Unable to refresh mining positions' },
          { refresh: vaultingRefresh, result: vaultingResult, fallback: 'Unable to refresh vault positions' },
          { refresh: bondsRefresh, result: bondsResult, fallback: 'Unable to refresh bond positions' },
          { refresh: bitcoinRefresh, result: bitcoinResult, fallback: 'Unable to refresh Bitcoin positions' },
        ];
        for (const { refresh, result, fallback } of results) {
          if (result.status !== 'rejected') continue;

          console.error(fallback, result.reason);
          financialPositionBook.fail(refresh, getErrorMessage(result.reason, fallback));
        }

        if (results.some(({ result }) => result.status === 'rejected')) scheduleAccountRefreshRetry();
        else resetAccountRefreshRetry();
      } else {
        scheduleAccountRefreshRetry();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh Argon wallet balances';
      if (refreshes.length === 0) {
        refreshes = mainchainFinancialGroups.map(group => financialPositionBook.beginRefresh(group));
      }
      financialPositionBook.fail(refreshes, message);
      scheduleAccountRefreshRetry();
    }
  }

  function queueAccountRefresh({
    header = getBlockWatch().bestBlockHeader,
    force = false,
  }: { header?: IBlockHeaderInfo; force?: boolean } = {}): Promise<void> {
    const bestHeader = getBlockWatch().bestBlockHeader;
    if (!isSameBlock(header, bestHeader)) header = bestHeader;
    const blockHash = header.blockHash.toLowerCase();
    const hasCurrentSnapshot = accountSnapshot.value?.observation.blockHash?.toLowerCase() === blockHash;
    const isQueued = queuedAccountHeader?.blockHash.toLowerCase() === blockHash;
    if (!force && (hasCurrentSnapshot || activeAccountHash === blockHash || isQueued)) {
      return accountRefreshPromise ?? Promise.resolve();
    }

    queuedAccountHeader = header;
    queuedAccountReconciliation ||= force;
    accountRefreshPromise ??= (async () => {
      while (queuedAccountHeader) {
        const nextHeader = queuedAccountHeader;
        const shouldForce = queuedAccountReconciliation;
        queuedAccountHeader = undefined;
        queuedAccountReconciliation = false;
        activeAccountHash = nextHeader.blockHash.toLowerCase();
        try {
          await refreshAccountSnapshot(nextHeader, shouldForce);
        } finally {
          activeAccountHash = '';
        }
      }
    })().finally(() => {
      accountRefreshPromise = undefined;
      if (queuedAccountHeader) void queueAccountRefresh({ force: queuedAccountReconciliation });
    });
    return accountRefreshPromise;
  }

  function scheduleAccountRefreshRetry(): void {
    if (accountRefreshRetryTimer || accountRefreshRetryAttempts >= 3) return;

    const retryDelayMs = 1_000 * 2 ** accountRefreshRetryAttempts;
    accountRefreshRetryAttempts += 1;
    accountRefreshRetryTimer = setTimeout(() => {
      accountRefreshRetryTimer = undefined;
      void queueAccountRefresh({ force: true });
    }, retryDelayMs);
  }

  function resetAccountRefreshRetry(): void {
    accountRefreshRetryAttempts = 0;
    if (!accountRefreshRetryTimer) return;

    clearTimeout(accountRefreshRetryTimer);
    accountRefreshRetryTimer = undefined;
  }

  async function prepareBitcoinPositions(snapshot: IArgonAccountSnapshot, header: IBlockHeaderInfo) {
    if (!config.hasExtensionTreasury) {
      return {
        positions: [],
        observation: snapshot.observation,
        summaries: [],
        hodlingInvestments: [],
        currentBitcoinDebt: 0n,
      };
    }
    if (!bitcoinLocks.data.isLoaded || !bitcoinFissions.data.isLoaded) return;

    const btcPrice = currency.priceIndex.btcUsdPrice;
    const argonTargetPrice = currency.priceIndex.argonUsdTargetPrice;
    const hasCurrentPrice = !!btcPrice && !btcPrice.isZero() && !!argonTargetPrice && !argonTargetPrice.isZero();
    const clientAt = await getBlockWatch().getApi(header);
    const bitcoin = await bitcoinFinancials.loadSnapshot({
      clientAt,
      hasCurrentPrice,
      ...(hasCurrentPrice && currency.priceIndex.argonUsdPrice ? { priceIndex: currency.priceIndex } : {}),
    });

    return {
      ...bitcoin,
      observation: snapshot.observation,
    };
  }

  async function refreshStableSwapPosition(): Promise<void> {
    // if (!config.hasExtensionTreasury || !config.hasActivatedStableSwaps) {
    //   publishEthereumWallet();
    //   return;
    // }
    //
    // try {
    //   if (stableSwaps.marketSnapshot) {
    //     await stableSwaps.refreshWalletSnapshot();
    //   } else {
    //     await stableSwapFinancials.loadPositions({ wallet: wallets.ethereumWallet });
    //   }
    // } catch (error) {
    //   console.error('Unable to load stable swap history', error);
    // }
    // publishEthereumWallet();
  }

  // Vaults ////////////////////////////////////////////////////////////////////////////////////////////////////////////

  const vaultsActiveRecords = Vue.shallowRef<Vault[]>([]);
  const vaultsIsLoaded = Vue.ref(false);

  async function loadVaults() {
    try {
      vaultsActiveRecords.value = Object.values(vaultStore.vaultsById)
        .filter(vault => vault.availableSecuritizationSpace() > 0n)
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

  async function refreshVaults(vaultIds?: number[]) {
    if (vaultIds?.length) {
      await Promise.all(vaultIds.map(vaultId => vaultStore.refreshVault(vaultId)));
    }
    await loadVaults();
  }

  // Savings ///////////////////////////////////////////////////////////////////////////////////////////////////////////

  const savingsTotalPending = Vue.computed(() => {
    const lockedRecords = liquidVisibleRecords.value.filter(x => {
      return bitcoinLocks.isLockFunded(x.record);
    });
    return lockedRecords.reduce((sum, lock) => sum + lock.pendingLiquidity, 0n);
  });
  const savingsTotalReadyToUse = Vue.computed(() => wallets.defaultArgonWallet.availableMicrogons);
  const savingsTotalValue = Vue.computed(() => {
    let total = savingsTotalPending.value + currency.convertSatToMicrogon(bitcoinWalletTotalSatoshis.value);
    for (const position of financialPositionAggregate.value.groupSummaries.liquid.positions) {
      if (position.kind !== 'wallet-balance' && position.kind !== 'wallet-holding') continue;
      if (position.accountId !== wallets.defaultArgonWallet.address || position.lifecycle === 'completed') continue;
      total += position.currentValue ?? 0n;
    }
    return total;
  });

  const savingsAllTimeFiatKey = Vue.ref(UnitOfMeasurement.USD);
  const savingsAllTimeReturn = Vue.computed(() => {
    if (!currency.usdTarget) return 0;
    const savingsReturnBn = BigNumber(currency.usdTarget - 1)
      .dividedBy(1)
      .multipliedBy(100);
    return savingsReturnBn.toNumber();
  });

  const savingsRestabilizationPower = Vue.computed(() => {
    if (!config.isLoaded) return 0;

    const source = getVaultingStatsSource();
    return calculateRestabilizationLeverage({
      argonBurnCapacity: source.argonBurnCapacity,
      microgonsInCirculation: microgonsInCirculation.value,
    });
  });

  const savingsIsLoaded = Vue.ref(false);

  // Argon Bonds ///////////////////////////////////////////////////////////////////////////////////////////////////////

  const bondSummariesByAsset = Vue.computed(() => {
    const positions = financialPositionAggregate.value.groupSummaries.bonds.positions.filter(position => {
      return position.kind === 'bond';
    });
    const argonPositions = positions.filter(position => position.nativeAsset === 'ARGN');
    const argonotPositions = positions.filter(position => position.nativeAsset === 'ARGNOT');

    return {
      ARGN: {
        currentValue: argonPositions.reduce((total, position) => total + (position.currentValue ?? 0n), 0n),
        returnSummary: calculatePositionReturn(argonPositions),
      },
      ARGNOT: {
        currentValue: argonotPositions.reduce((total, position) => total + (position.currentValue ?? 0n), 0n),
        returnSummary: calculatePositionReturn(argonotPositions),
      },
    };
  });
  const bondsTotalValue = Vue.computed(() => {
    return financialPositionAggregate.value.groupSummaries.bonds.currentValue;
  });
  // Bitcoin Liquid Locks ///////////////////////////////////////////////////////////////////////////////////////////////

  const liquidAllRecords = Vue.ref<IBitcoinLockSummary[]>([]);
  const bitcoinLiquids = Vue.computed(() => bitcoinFissions.getLiquids());

  const bitcoinLockSummaries = Vue.computed<IBitcoinLockSummary[]>(() => {
    const summariesByUuid = new Map(liquidAllRecords.value.map(summary => [summary.uuid, summary]));
    for (const lock of bitcoinLocks.getAllLocks({ includeHistoryRecoveryPending: true })) {
      const summary = summariesByUuid.get(lock.uuid);
      if (summary) {
        const summaryWithLiveRecord = {
          ...summary,
          statusDetails: { ...summary.statusDetails },
          record: lock,
        };
        bitcoinLocks.refreshLockSummary(summaryWithLiveRecord);
        summariesByUuid.set(lock.uuid, summaryWithLiveRecord);
      } else {
        summariesByUuid.set(lock.uuid, bitcoinLocks.createLockSummary(lock));
      }
    }
    return [...summariesByUuid.values()];
  });

  const liquidInvisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return bitcoinLockSummaries.value.filter(lock => {
      if (!bitcoinLocks.isInactiveForVaultDisplay(lock.record)) return false;
      return !!lock.record.removalReason || bitcoinLocks.isFinishedStatus(lock.record);
    });
  });

  const liquidVisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return bitcoinLockSummaries.value.filter(
      lock => !lock.record.isHistoryRecoveryPending && !bitcoinLocks.isInactiveForVaultDisplay(lock.record),
    );
  });

  const bitcoinLockDisplayRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return bitcoinLockSummaries.value
      .filter(lock => !bitcoinLocks.isInactiveForVaultDisplay(lock.record))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  });

  const bitcoinLockPerformanceByUuid = Vue.computed(() => {
    const performanceByUuid: Record<string, { profit: bigint; percent: number }> = {};
    for (const summary of bitcoinLockSummaries.value) {
      const { record } = summary;
      if (
        record.removalReason !== 'released' ||
        record.isHistoryRecoveryPending ||
        record.removalBlockTime === undefined ||
        record.releaseRedemptionMicrogons === undefined ||
        record.releaseArgonTxFeeMicrogons === undefined ||
        summary.historicalTotalFees === undefined ||
        valueSatoshisAtRate(summary.satoshis, record.btcPriceAtRemovalMicrogons) === undefined ||
        valueSatoshisAtRate(record.fundingUtxo?.releaseBitcoinNetworkFee, record.btcPriceAtRemovalMicrogons) ===
          undefined
      ) {
        continue;
      }

      const endingCapital = calculateBitcoinEndingCapital({
        bitcoinValue: summary.startingCapital,
        receivedLiquidity: summary.receivedLiquidity,
        pendingLiquidity: summary.pendingLiquidity,
        redemptionAmount: record.releaseRedemptionMicrogons,
        fees: summary.historicalTotalFees,
        compensation: record.releaseCompensationMicrogons ?? 0n,
      });
      performanceByUuid[summary.uuid] = {
        profit: endingCapital - summary.startingCapital,
        percent: calculateBitcoinReturn(summary.startingCapital, endingCapital),
      };
    }

    return performanceByUuid;
  });

  const liquidLockedRecords = Vue.computed(() => {
    return bitcoinLockSummaries.value.filter(lock => bitcoinLocks.isLockFunded(lock.record));
  });

  const bitcoinWalletTotalSatoshis = Vue.computed(() => {
    return liquidLockedRecords.value.reduce((sum, l) => sum + l.satoshis, 0n);
  });

  const liquidTotalSatoshis = Vue.computed(() => {
    return bitcoinLiquids.value
      .filter(liquid => !liquid.isClosed)
      .reduce((total, liquid) => total + liquid.satoshis, 0n);
  });

  const liquidPerformanceReturn = Vue.computed(() => {
    if (bitcoinLockDisplayRecords.value.some(lock => lock.record.isHistoryRecoveryPending)) return;

    const percent = financialPositionAggregate.value.groupSummaries.bitcoin.returnSummary.percent;
    if (bitcoinLockDisplayRecords.value.length && percent === undefined) return;

    return percent ?? 0;
  });

  const liquidHodlingInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const liquidHodlingReturn = Vue.computed(() => {
    if (bitcoinLockDisplayRecords.value.some(lock => lock.record.isHistoryRecoveryPending)) return;

    const percent = calculatePerformanceReturn(liquidHodlingInvestments.value).percent;
    if (bitcoinLockDisplayRecords.value.length && percent === undefined) return;

    return percent ?? 0;
  });

  const liquidCurrentBitcoinDebt = Vue.ref(0n);
  let lockSummaryProgressInterval: ReturnType<typeof setInterval> | undefined;

  function refreshLockSummaryProgress() {
    for (const summary of liquidAllRecords.value) {
      bitcoinLocks.refreshLockSummary(summary);
    }
  }

  function startLockSummaryProgressRefresh() {
    if (lockSummaryProgressInterval) return;
    lockSummaryProgressInterval = setInterval(refreshLockSummaryProgress, 1_000);
  }

  Vue.watch(
    () => bitcoinLocks.data.latestArgonBlock?.blockNumber,
    () => {
      if (!isLoaded.value) return;
      const bitcoinSnapshot = financialPositionBook.snapshots.find(snapshot => snapshot.group === 'bitcoin');
      if (bitcoinSnapshot?.state !== 'stale') return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => [currency.priceIndex.btcUsdPrice?.toString(), currency.priceIndex.argonUsdTargetPrice?.toString()],
    () => {
      if (!isLoaded.value) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () =>
      wallets.ethereumWallets.persistedWallets.map(wallet => [
        wallet.id,
        wallet.data.balanceUpdatedAt,
        wallet.data.balanceIsCached,
        wallet.data.fetchErrorMsg,
        wallet.data.availableMicrogons,
        wallet.data.availableMicronots,
        wallet.data.otherTokens,
      ]),
    () => {
      if (!isLoaded.value) return;
      publishEthereumWallet();
    },
    { deep: true },
  );

  // Vue.watch(
  //   () => [wallets.ethereumWallet.address, wallets.ethereumWallet.availableMicrogons],
  //   ([address], [previousAddress]) => {
  //     if (!isLoaded.value) return;
  //     if (!config.hasActivatedStableSwaps) return;
  //     if (
  //       address !== previousAddress ||
  //       (!stableSwaps.marketSnapshot && wallets.ethereumWallet.availableMicrogons > 0n)
  //     ) {
  //       void refreshStableSwapPosition();
  //     }
  //   },
  // );

  Vue.watch(
    () => config.isLoaded && config.hasActivatedStableSwaps,
    () => {
      if (!isLoaded.value) return;
      void refreshStableSwapPosition();
    },
  );

  Vue.watch(
    () => [stableSwaps.walletSnapshot, stableSwaps.marketSnapshot],
    () => {
      if (!isLoaded.value || !config.hasActivatedStableSwaps) return;
      publishEthereumWallet();
    },
  );

  wallets.on('balance-change', () => {
    if (!isLoaded.value) return;
    void queueAccountRefresh();
  });

  walletsForArgon.events.on('history:recovered', revisions => {
    const historyCutoff = getBlockWatch().finalizedBlockHeader.blockNumber;
    if (!isLoaded.value || revisions.asOfBlock < historyCutoff) return;
    if (
      lastCoveredWalletSnapshotBlock >= historyCutoff &&
      lastPublishedArgonotCustodyRevision >= revisions.argonotCustody
    ) {
      void queueAccountRefresh({ force: true });
      return;
    }

    queuedWalletHistoryBlock = Math.max(queuedWalletHistoryBlock, revisions.asOfBlock);
    queuedArgonotCustodyRevision = Math.max(queuedArgonotCustodyRevision, revisions.argonotCustody);
    walletHistoryCoverage = undefined;
    walletHistoryRefreshPromise ??= Promise.resolve()
      .then(async () => {
        while (true) {
          const refreshBlock = queuedWalletHistoryBlock;
          const refreshRevision = queuedArgonotCustodyRevision;
          const currentHistoryCutoff = getBlockWatch().finalizedBlockHeader.blockNumber;
          if (refreshBlock < currentHistoryCutoff) return;

          await queueAccountRefresh({ force: true });
          lastPublishedArgonotCustodyRevision = refreshRevision;
          if (refreshBlock === queuedWalletHistoryBlock && refreshRevision === queuedArgonotCustodyRevision) return;
        }
      })
      .catch(error => {
        console.warn('Unable to refresh recovered financial positions', error);
      })
      .finally(() => {
        walletHistoryRefreshPromise = undefined;
      });
  });

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionTreasury ? argonBonds.data.financialRevision : 0),
    () => {
      if (!accountSourcesAreLoaded || !config.hasExtensionTreasury || !argonBonds.data.isLoaded) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionTreasury ? bitcoinLocks.data.financialRevision : 0),
    () => {
      if (!accountSourcesAreLoaded || !config.hasExtensionTreasury || !bitcoinLocks.data.isLoaded) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionTreasury ? bitcoinFissions.data.financialRevision : 0),
    () => {
      if (!accountSourcesAreLoaded || !config.hasExtensionTreasury || !bitcoinFissions.data.isLoaded) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionOperations ? myVault.data.financialRevision : 0),
    () => {
      if (!accountSourcesAreLoaded || !config.hasExtensionOperations || !myVault.data.isLoaded) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => currency.microgonsPer.ARGNOT,
    () => {
      if (!isLoaded.value) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionOperations ? getMyMiningSeatsSource().financialRevision : 0),
    () => {
      if (!accountSourcesAreLoaded || !config.hasExtensionOperations || !getMyMiningSeatsSource().isLoaded) return;
      const sourceBlockNumber = getMyMiningSeatsSource().serverState.argonLocalNodeBlockNumber;
      if (sourceBlockNumber && sourceBlockNumber > (accountSnapshot.value?.observation.blockNumber ?? 0)) return;

      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => (config.isLoaded ? [config.hasExtensionTreasury, config.hasExtensionOperations] : [false, false]),
    async () => {
      if (!isLoaded.value) return;

      try {
        if (config.hasExtensionTreasury) {
          startLockSummaryProgressRefresh();
        }
        await refreshStableSwapPosition();

        // The basic app snapshot omits hold details. Reload the current best
        // block when a domain activates so its positions can claim those holds.
        accountSnapshot.value = undefined;
        await queueAccountRefresh({ force: true });
      } catch (error) {
        console.error('Unable to activate financial positions', error);
      }
    },
  );

  // Stable Swaps //////////////////////////////////////////////////////////////////////////////////////////////////////

  const swapsTotalValue = Vue.computed(() => {
    return 0n;
    // const micronotValue = currency.convertMicronotTo(
    //   wallets.ethereumWallet.availableMicronots,
    //   UnitOfMeasurement.Microgon,
    // );
    // const otherTokenValue = wallets.ethereumWallet.otherTokens.reduce((totalValue, token) => {
    //   return totalValue + currency.convertOtherToMicrogon(token);
    // }, 0n);
    //
    // return wallets.ethereumWallet.availableMicrogons + micronotValue + otherTokenValue;
  });

  const stableSwapPerformanceReturn = Vue.computed(() => {
    const positions = financialPositionAggregate.value.groupSummaries.ethereum.positions.filter(position => {
      return position.kind === 'stable-swap';
    });
    return calculatePositionReturn(positions).percent;
  });

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  function setFinancialScope(): void {
    const ownedAccounts = [
      wallets.defaultArgonWallet.address,
      wallets.miningBotWallet.address,
      wallets.operationalWallet.address,
      ...wallets.ethereumWallets.persistedWallets.map(wallet => wallet.address),
    ].filter(Boolean);
    financialPositionBook.setScope({
      ownedAccounts: [...new Set(ownedAccounts)],
    });
  }

  async function load() {
    const loadStartedAt = performance.now();
    setFinancialScope();
    await config.isLoadedPromise;
    const configReadyAt = performance.now();
    await Promise.all([wallets.isLoadedPromise, currency.isLoadedPromise]);
    accountSourcesAreLoaded = true;
    const walletSourcesReadyAt = performance.now();
    setFinancialScope();
    if (!config.hasExtensionTreasury) {
      vaultsIsLoaded.value = true;
    }
    await queueAccountRefresh({ force: true });
    const defaultArgonReadyAt = performance.now();
    logStartupTiming({
      milestone: 'default-argon-financials-ready',
      startedAt: loadStartedAt,
      details: {
        configMs: Math.round(configReadyAt - loadStartedAt),
        walletSourcesMs: Math.round(walletSourcesReadyAt - configReadyAt),
        accountSnapshotMs: Math.round(defaultArgonReadyAt - walletSourcesReadyAt),
      },
    });
    savingsIsLoaded.value = true;
    publishEmptyBaseGroup();
    void refreshStableSwapPosition();
    if (config.hasExtensionTreasury) startLockSummaryProgressRefresh();

    isLoaded.value = true;
    publishEthereumWallet();
    void getVaultingStatsSource().isLoadedPromise.catch(error => {
      console.error('Unable to load vaulting statistics', error);
    });
    void currency
      .fetchMicrogonsInCirculation()
      .then(value => {
        microgonsInCirculation.value = value;
      })
      .catch(error => {
        console.error('Unable to load currency circulation', error);
      });
    if (config.hasExtensionTreasury) {
      void getVaultingStatsSource()
        .isLoadedPromise.then(() => loadVaults())
        .catch(error => {
          console.error('Unable to load active vaults', error);
        });
    }
  }

  void load().catch(error => {
    console.error('Unable to load financial positions', error);
    const message = error instanceof Error ? error.message : 'Unable to load financial positions';
    for (const group of financialGroups) {
      financialPositionBook.fail(financialPositionBook.beginRefresh(group), message);
    }
    savingsIsLoaded.value = true;
    vaultsIsLoaded.value = true;
    isLoaded.value = true;
  });

  return {
    vaultsActiveRecords,
    vaultsIsLoaded,
    refreshVaults,

    savingsTotalPending,
    savingsTotalReadyToUse,
    savingsTotalValue,
    savingsAllTimeFiatKey,
    savingsAllTimeReturn,
    savingsRestabilizationPower,
    savingsIsLoaded,

    bondsTotalValue,
    bondSummariesByAsset,

    liquidAllRecords,
    bitcoinLiquids,
    bitcoinLockDisplayRecords,
    bitcoinLockPerformanceByUuid,
    liquidVisibleRecords,
    liquidInvisibleRecords,
    liquidLockedRecords,
    bitcoinWalletTotalSatoshis,
    liquidTotalSatoshis,
    liquidCurrentBitcoinDebt,
    liquidPerformanceReturn,
    liquidHodlingReturn,

    swapsTotalValue,
    stableSwapPerformanceReturn,

    financialPositionAggregate,
    liquidNativeBalances,
  };
});

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isSameBlock(left: Pick<IBlockHeaderInfo, 'blockHash'>, right: Pick<IBlockHeaderInfo, 'blockHash'>): boolean {
  return left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}

function isOnCurrentBestChain(header: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>): boolean {
  const blockWatch = getBlockWatch();
  if (blockWatch.latestHeaders.some(candidate => isSameBlock(candidate, header))) return true;

  const finalizedHash = blockWatch.finalizedHashes[header.blockNumber];
  return finalizedHash !== undefined && finalizedHash.toLowerCase() === header.blockHash.toLowerCase();
}
