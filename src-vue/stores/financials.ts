import { defineStore } from 'pinia';
import * as Vue from 'vue';
import { getWalletHistoryRecovery, getWalletsForArgon, useWallets } from './wallets.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';
import { getArgonBonds } from './argonBonds.ts';
import { getBlockWatch } from './mainchain.ts';
import {
  type ArgonQueryClient,
  calculatePerformanceReturn,
  type IBlockHeaderInfo,
  type IPerformanceReturnInput,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { MICROGONS_PER_ARGON, Vault } from '@argonprotocol/mainchain';
import { getVaults, getMyVault } from './vaults.ts';
import {
  financialGroups,
  type IFinancialObservation,
  type IFinancialPosition,
} from '../interfaces/IFinancialPosition.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import {
  getEnabledFinancialHistoryDomains,
  needsFinancialHistoryRecovery,
  restoreFinancialHistory as restoreFinancialHistoryFromIndex,
} from '../lib/recovery/index.ts';
import { FinalizedHistoryScheduler } from '../lib/recovery/Scheduler.ts';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { calculatePositionReturn, FinancialPositionBook, reduceFinancialPositions } from '../lib/financials/index.ts';
import { BitcoinFinancials } from '../lib/financials/BitcoinLocks.ts';
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
  const currency = getCurrency();
  const config = getConfig();
  const vaultStore = getVaults();
  const myVault = getMyVault();
  const stableSwaps = useStableSwaps();
  const walletFinancials = new WalletFinancials(walletsForArgon);
  const bondFinancials = new ArgonBondsFinancials(argonBonds);
  const bitcoinFinancials = new BitcoinFinancials(bitcoinLocks);
  const vaultFinancials = new VaultFinancials(myVault);
  const stableSwapFinancials = new StableSwapFinancials(stableSwaps);
  let myMiningSeats: ReturnType<typeof getMyMiningSeats> | undefined;
  let miningFinancials: MiningFinancials | undefined;
  let vaultingStats: ReturnType<typeof useVaultingStats> | undefined;

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
  const historyRecovery = Vue.ref<{
    state: 'checking' | 'restoring' | 'waiting' | 'ready' | 'error';
    recoveredBlockCount: number;
    message?: string;
  }>({ state: 'checking', recoveredBlockCount: 0 });
  let hasConfirmedFinancialHistoryCoverage = false;
  let queuedAccountHeader: IBlockHeaderInfo | undefined;
  let queuedAccountReconciliation = false;
  let activeAccountHash = '';
  let accountRefreshPromise: Promise<void> | undefined;
  let accountRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let accountRefreshRetryAttempts = 0;
  let lastCoveredWalletSnapshotBlock = 0;
  let lastPublishedArgonotCustodyRevision = 0;
  let queuedWalletHistoryBlock = 0;
  let queuedArgonotCustodyRevision = 0;
  let walletHistoryCoverage: { blockNumber: number; promise: Promise<boolean> } | undefined;
  let walletHistoryRefreshPromise: Promise<void> | undefined;
  const finalizedHistoryScheduler = new FinalizedHistoryScheduler(async (finalizedBlockNumber, force) => {
    if (!isLoaded.value) return 0;
    if (!force && !config.hasExtensionTreasury && !config.hasExtensionOperations) {
      return finalizedBlockNumber;
    }
    return runFinancialHistoryRecovery(force, finalizedBlockNumber);
  });
  Vue.onScopeDispose(() => {
    resetAccountRefreshRetry();
  });

  function publishEthereumWallet(): void {
    if (!wallets.ethereumWallet.address) {
      financialPositionBook.publish(financialPositionBook.beginRefresh('ethereum'), [], { observedAt: new Date() });
      return;
    }
    if (!wallets.ethereumWallet.balanceUpdatedAt && !wallets.ethereumWallet.fetchErrorMsg) return;

    const refresh = financialPositionBook.beginRefresh('ethereum');
    const positions: IFinancialPosition[] = [...wallets.ethereumFinancialPositions];

    if (config.hasActivatedStableSwaps && !wallets.ethereumWallet.fetchErrorMsg) {
      const [stableSwapPosition] = stableSwapFinancials.createFinancialPositions({
        wallet: wallets.ethereumWallet,
        walletSnapshot: stableSwaps.walletSnapshot,
        currentPriceMicrogons: stableSwaps.marketSnapshot?.currentPriceMicrogons,
      });
      if (stableSwapPosition?.currentValue !== undefined) {
        const argonPositionIndex = positions.findIndex(position => position.id === stableSwapPosition.id);
        if (argonPositionIndex === -1) positions.push(stableSwapPosition);
        else positions[argonPositionIndex] = stableSwapPosition;
      }
    }

    financialPositionBook.publish(refresh, positions, {
      observedAt: new Date(),
    });
    if (wallets.ethereumWallet.balanceIsCached) {
      financialPositionBook.fail(refresh, 'Refreshing cached Ethereum balances');
    }
  }

  function publishBaseWallet(): void {
    if (!wallets.baseWallet.balanceUpdatedAt && !wallets.baseWallet.fetchErrorMsg) return;

    const refresh = financialPositionBook.beginRefresh('base');
    financialPositionBook.publish(refresh, wallets.baseFinancialPositions, { observedAt: new Date() });
    if (wallets.baseWallet.balanceIsCached) {
      financialPositionBook.fail(refresh, 'Refreshing cached Base balances');
    }
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

  async function loadEnabledDomainSources(): Promise<void> {
    const loads: Promise<unknown>[] = [];
    if (config.hasExtensionTreasury) {
      loads.push(argonBonds.load(), bitcoinLocks.load(), vaultStore.load(), getVaultingStatsSource().isLoadedPromise);
    }
    if (config.hasExtensionOperations) {
      loads.push(getMyMiningSeatsSource().isLoadedPromise, myVault.load());
    }
    const results = await Promise.allSettled(loads);

    if (config.hasExtensionTreasury) {
      results.push(...(await Promise.allSettled([loadVaults()])));
    }
    for (const result of results) {
      if (result.status === 'rejected') console.error('Unable to load a financial domain', result.reason);
    }
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

  async function prepareBondPositions(snapshot: IArgonAccountSnapshot, clientAt: ArgonQueryClient) {
    if (!config.hasExtensionTreasury) {
      return { positions: [], claimsHolds: false };
    }

    const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
    if (!account) throw new Error('Default Argon account is missing from the wallet snapshot');

    const positions = await bondFinancials.loadPositions({
      account,
      clientAt,
      hasConfirmedBondHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
      liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
      ownedVaultId: myVault.createdVault?.vaultId,
    });
    return { positions, claimsHolds: true };
  }

  async function prepareMiningPositions(snapshot: IArgonAccountSnapshot) {
    if (!config.hasExtensionOperations) {
      return { positions: [], claimsHolds: false };
    }

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

    const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
    if (!account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');

    const positions = await vaultFinancials.loadPositions({
      account,
      liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
      hasConfirmedHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
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
      if (!isSameBlock(header, getBlockWatch().bestBlockHeader)) {
        void queueAccountRefresh({ force: true });
        return;
      }

      const [miningResult, vaultingResult, bondsResult, bitcoinResult] = await Promise.allSettled([
        prepareMiningPositions(candidate),
        prepareVaultPositions(candidate),
        prepareBondPositions(candidate, clientAt),
        prepareBitcoinPositions(candidate, header),
      ]);
      const currentGroups = financialPositionAggregate.value.groupSummaries;
      const [liquidResult] = await Promise.allSettled([
        prepareWalletPositions({
          snapshot: candidate,
          treasuryHoldsAreClaimed:
            bondsResult.status === 'fulfilled'
              ? bondsResult.value.claimsHolds
              : currentGroups.bonds.positions.length > 0,
          miningClaimsHolds:
            miningResult.status === 'fulfilled'
              ? miningResult.value.claimsHolds
              : currentGroups.mining.positions.length > 0,
          vaultClaimsHolds:
            vaultingResult.status === 'fulfilled'
              ? vaultingResult.value.claimsHolds
              : currentGroups.vaulting.positions.length > 0,
        }),
      ]);
      if (!isSameBlock(header, getBlockWatch().bestBlockHeader)) {
        void queueAccountRefresh({ force: true });
        return;
      }

      refreshes = mainchainFinancialGroups.map(group => financialPositionBook.beginRefresh(group));
      const [liquidRefresh, miningRefresh, vaultingRefresh, bondsRefresh, bitcoinRefresh] = refreshes;
      const updates: Parameters<FinancialPositionBook['commit']>[0][number][] = [];
      if (liquidResult.status === 'fulfilled') {
        updates.push({ refresh: liquidRefresh, positions: liquidResult.value, observation: candidate.observation });
      }
      if (miningResult.status === 'fulfilled') {
        updates.push({
          refresh: miningRefresh,
          positions: miningResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (vaultingResult.status === 'fulfilled') {
        updates.push({
          refresh: vaultingRefresh,
          positions: vaultingResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (bondsResult.status === 'fulfilled') {
        updates.push({
          refresh: bondsRefresh,
          positions: bondsResult.value.positions,
          observation: candidate.observation,
        });
      }
      if (bitcoinResult.status === 'fulfilled') {
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
        if (bitcoinResult.status === 'fulfilled') {
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

    const btcPrice = currency.priceIndex.btcUsdPrice;
    const argonTargetPrice = currency.priceIndex.argonUsdTargetPrice;
    const hasCurrentPrice = !!btcPrice && !btcPrice.isZero() && !!argonTargetPrice && !argonTargetPrice.isZero();
    const clientAt = await getBlockWatch().getApi(header);
    const bitcoin = await bitcoinFinancials.loadSnapshot({
      clientAt,
      hasCurrentPrice,
      hasConfirmedHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
    });

    return {
      ...bitcoin,
      observation: snapshot.observation,
    };
  }

  async function refreshStableSwapPosition(): Promise<void> {
    if (!config.hasExtensionTreasury || !config.hasActivatedStableSwaps) {
      publishEthereumWallet();
      return;
    }

    try {
      if (stableSwaps.marketSnapshot) {
        await stableSwaps.refreshWalletSnapshot();
      } else {
        await stableSwapFinancials.loadPositions({ wallet: wallets.ethereumWallet });
      }
    } catch (error) {
      console.error('Unable to load stable swap history', error);
    }
    publishEthereumWallet();
  }

  // Vaults ////////////////////////////////////////////////////////////////////////////////////////////////////////////

  const vaultsActiveRecords = Vue.shallowRef<Vault[]>([]);
  const vaultsIsLoaded = Vue.ref(false);

  async function loadVaults() {
    try {
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
      return bitcoinLocks.isLockedStatus(x.record);
    });
    return lockedRecords.reduce((sum, lock) => sum + lock.pendingLiquidity, 0n);
  });
  const savingsTotalReadyToUse = Vue.computed(() => wallets.defaultArgonWallet.availableMicrogons);
  const savingsTotalValue = Vue.computed(() => {
    let total = savingsTotalPending.value;
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
    if (!config.isLoaded || !config.hasExtensionTreasury) return 0;

    const source = getVaultingStatsSource();
    const microgonValueInVaults = source.microgonValueInVaults;
    if (!microgonValueInVaults) return 0;

    const microgonBurnCapacity = BigInt(Math.round(source.argonBurnCapacity * MICROGONS_PER_ARGON));
    return BigNumber(microgonBurnCapacity).dividedBy(microgonValueInVaults).toNumber();
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

  const liquidInvisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => bitcoinLocks.isInactiveForVaultDisplay(l.record));
  });

  const liquidVisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return liquidAllRecords.value.filter(
      lock => !lock.record.isHistoryRecoveryPending && !bitcoinLocks.isInactiveForVaultDisplay(lock.record),
    );
  });

  const bitcoinLockDisplayRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    const recoveringRecords = bitcoinLocks
      .getAllLocks({ includeHistoryRecoveryPending: true })
      .filter(lock => lock.isHistoryRecoveryPending && !bitcoinLocks.isInactiveForVaultDisplay(lock))
      .map(lock => bitcoinLocks.createLockSummary(lock));

    return [...liquidVisibleRecords.value, ...recoveringRecords].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  });

  const liquidLockedRecords = Vue.computed(() => {
    return liquidVisibleRecords.value.filter(lock => bitcoinLocks.isLockedStatus(lock.record));
  });

  const liquidTotalSatoshis = Vue.computed(() => {
    return liquidLockedRecords.value.reduce((sum, l) => sum + l.satoshis, 0n);
  });

  const liquidPerformanceReturn = Vue.computed(() => {
    return financialPositionAggregate.value.groupSummaries.bitcoin.returnSummary.percent ?? 0;
  });

  const liquidHodlingInvestments = Vue.ref<IPerformanceReturnInput[]>([]);
  const liquidHodlingReturn = Vue.computed(() => {
    return calculatePerformanceReturn(liquidHodlingInvestments.value).percent;
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
    () => [bitcoinLocks.data.locksByUtxoId, bitcoinLocks.data.pendingLocks],
    () => {
      if (!isLoaded.value) return;
      void queueAccountRefresh({ force: true });
    },
    { deep: true },
  );

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
    () => wallets.ethereumWallet,
    () => {
      if (!isLoaded.value) return;
      publishEthereumWallet();
    },
    { deep: true },
  );

  Vue.watch(
    () => [wallets.ethereumWallet.address, wallets.ethereumWallet.availableMicrogons],
    ([address], [previousAddress]) => {
      if (!isLoaded.value) return;
      if (!config.hasActivatedStableSwaps) return;
      if (
        address !== previousAddress ||
        (!stableSwaps.marketSnapshot && wallets.ethereumWallet.availableMicrogons > 0n)
      ) {
        void refreshStableSwapPosition();
      }
    },
  );

  Vue.watch(
    () => wallets.baseWallet,
    () => {
      if (!isLoaded.value) return;
      publishBaseWallet();
    },
    { deep: true },
  );

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

  walletsForArgon.events.on('history:gap', gap => {
    if (!config.hasExtensionTreasury && !config.hasExtensionOperations) return;

    void restoreFinancialHistory(false, gap.toBlock).catch(() => undefined);
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
    () => [argonBonds.data.bondLots, argonBonds.data.bondHistory],
    () => {
      if (!isLoaded.value || !config.hasExtensionTreasury) return;
      void queueAccountRefresh({ force: true });
    },
  );

  Vue.watch(
    () => [
      myVault.createdVault,
      myVault.data.pendingCollectRevenue,
      myVault.data.argonotCommitment.committedMicronots,
      myVault.data.argonotCommitment.encumberedMicronots,
    ],
    () => {
      if (!isLoaded.value || !config.hasExtensionOperations) return;
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
      if (!isLoaded.value || !config.hasExtensionOperations) return;
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
        await loadEnabledDomainSources();
        if (config.hasExtensionTreasury) {
          startLockSummaryProgressRefresh();
        }
        await refreshStableSwapPosition();

        // The basic app snapshot omits hold details. Reload the current best
        // block when a domain activates so its positions can claim those holds.
        accountSnapshot.value = undefined;
        await queueAccountRefresh({ force: true });
        if (config.walletAccountsHadPreviousLife && (config.hasExtensionTreasury || config.hasExtensionOperations)) {
          void initializeFinancialHistoryRecovery().catch(() => undefined);
        }
      } catch (error) {
        console.error('Unable to activate financial positions', error);
      }
    },
  );

  // Stable Swaps //////////////////////////////////////////////////////////////////////////////////////////////////////

  const swapsTotalValue = Vue.computed(() => {
    const micronotValue = currency.convertMicronotTo(
      wallets.ethereumWallet.availableMicronots,
      UnitOfMeasurement.Microgon,
    );
    const otherTokenValue = wallets.ethereumWallet.otherTokens.reduce((totalValue, token) => {
      return totalValue + currency.convertOtherToMicrogon(token);
    }, 0n);

    return wallets.ethereumWallet.availableMicrogons + micronotValue + otherTokenValue;
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
      wallets.ethereumWallet.address,
      wallets.baseWallet.address,
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
    if (!config.walletAccountsHadPreviousLife) {
      hasConfirmedFinancialHistoryCoverage = true;
      historyRecovery.value = { state: 'ready', recoveredBlockCount: 0 };
    }
    await Promise.all([wallets.isLoadedPromise, currency.isLoadedPromise]);
    const walletSourcesReadyAt = performance.now();
    setFinancialScope();
    await loadEnabledDomainSources();
    const domainSourcesReadyAt = performance.now();

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
        domainSourcesMs: Math.round(domainSourcesReadyAt - walletSourcesReadyAt),
        accountSnapshotMs: Math.round(defaultArgonReadyAt - domainSourcesReadyAt),
      },
    });
    savingsIsLoaded.value = true;
    publishBaseWallet();
    void refreshStableSwapPosition();
    if (config.hasExtensionTreasury) startLockSummaryProgressRefresh();

    isLoaded.value = true;
    if (config.walletAccountsHadPreviousLife && (config.hasExtensionTreasury || config.hasExtensionOperations)) {
      void initializeFinancialHistoryRecovery().catch(() => undefined);
    }
  }

  async function initializeFinancialHistoryRecovery(): Promise<void> {
    const enabledDomains = getEnabledFinancialHistoryDomains({
      force: false,
      hasExtensionTreasury: config.hasExtensionTreasury,
      hasExtensionOperations: config.hasExtensionOperations,
      walletAccountsHadPreviousLife: config.walletAccountsHadPreviousLife,
    });
    const db = await getDbPromise();
    const targetBlock = getBlockWatch().finalizedBlockHeader.blockNumber;
    const needsRecovery = await needsFinancialHistoryRecovery({
      db,
      accountId: wallets.defaultArgonWallet.address,
      enabledDomains,
      targetBlock,
      bitcoinLockRecovery: bitcoinLocks.recovery,
    });
    if (needsRecovery) {
      await restoreFinancialHistory(false, targetBlock);
      return;
    }

    hasConfirmedFinancialHistoryCoverage = true;
    historyRecovery.value = { state: 'ready', recoveredBlockCount: 0 };
  }

  function restoreFinancialHistory(force = false, minimumAsOfBlock?: number): Promise<void> {
    const targetBlock = minimumAsOfBlock ?? getBlockWatch().finalizedBlockHeader.blockNumber;
    return finalizedHistoryScheduler.runNow(targetBlock, force);
  }

  async function runFinancialHistoryRecovery(force: boolean, targetBlock: number): Promise<number> {
    const shouldShowRecovery = force || !hasConfirmedFinancialHistoryCoverage;

    try {
      const db = await getDbPromise();
      const enabledDomains = getEnabledFinancialHistoryDomains({
        force,
        hasExtensionTreasury: config.hasExtensionTreasury,
        hasExtensionOperations: config.hasExtensionOperations,
        walletAccountsHadPreviousLife: config.walletAccountsHadPreviousLife,
      });
      const historyLoads: Promise<unknown>[] = [];
      if (enabledDomains.includes('bonds')) historyLoads.push(argonBonds.load());
      if (enabledDomains.includes('bitcoin')) historyLoads.push(bitcoinLocks.load());
      await Promise.all(historyLoads);

      const result = await restoreFinancialHistoryFromIndex({
        db,
        blockWatch: getBlockWatch(),
        accountId: wallets.defaultArgonWallet.address,
        argonBonds,
        bitcoinLockRecovery: bitcoinLocks.recovery,
        vaultHistory: myVault.history,
        enabledDomains,
        force,
        minimumAsOfBlock: targetBlock,
        onCheckStart() {
          if (!shouldShowRecovery) return;
          historyRecovery.value = { state: 'checking', recoveredBlockCount: 0 };
        },
        onProgress(recoveredBlockCount) {
          if (!shouldShowRecovery) return;
          historyRecovery.value = {
            state: 'restoring',
            recoveredBlockCount,
          };
        },
      });
      if (result.asOfBlock >= targetBlock) {
        hasConfirmedFinancialHistoryCoverage = true;
        historyRecovery.value = { state: 'ready', recoveredBlockCount: result.importedBlockCount };
      } else if (shouldShowRecovery) {
        historyRecovery.value = {
          state: 'waiting',
          recoveredBlockCount: result.importedBlockCount,
          message: `Investment history is indexed through block ${result.asOfBlock.toLocaleString()} and is still catching up`,
        };
      }
      await queueAccountRefresh({ force: true });
      return result.asOfBlock;
    } catch (error) {
      if (shouldShowRecovery) {
        historyRecovery.value = {
          state: 'error',
          recoveredBlockCount: historyRecovery.value.recoveredBlockCount,
          message: error instanceof Error ? error.message : 'Unable to restore investment history',
        };
      }
      throw error;
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
    historyRecovery.value = {
      state: 'error',
      recoveredBlockCount: 0,
      message,
    };
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
    bondSummariesByAsset,

    liquidAllRecords,
    bitcoinLockDisplayRecords,
    liquidVisibleRecords,
    liquidInvisibleRecords,
    liquidLockedRecords,
    liquidTotalSatoshis,
    liquidCurrentBitcoinDebt,
    liquidPerformanceReturn,
    liquidHodlingReturn,

    swapsTotalValue,
    stableSwapPerformanceReturn,

    financialPositionAggregate,
    liquidNativeBalances,
    historyRecovery,
    restoreFinancialHistory,
  };
});

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isSameBlock(left: Pick<IBlockHeaderInfo, 'blockHash'>, right: Pick<IBlockHeaderInfo, 'blockHash'>): boolean {
  return left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}
