import { defineStore } from 'pinia';
import * as Vue from 'vue';
import { getWalletHistoryRecovery, getWalletsForArgon, useWallets } from './wallets.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';
import { getArgonBonds } from './argonBonds.ts';
import { getBlockWatch } from './mainchain.ts';
import {
  bigIntMax,
  calculateModifiedDietzReturn,
  calculatePerformanceReturn,
  Currency as CoreCurrency,
  type IAccountCashFlow,
  type IBlockHeaderInfo,
  type IPerformanceReturnInput,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { MICROGONS_PER_ARGON, Vault } from '@argonprotocol/mainchain';
import { getVaults, getMyVault } from './vaults.ts';
import {
  financialGroups,
  type IFinancialAccountReturnSummary,
  type IFinancialObservation,
  type IFinancialPosition,
  type IWalletBalanceFinancialPosition,
  type IWalletHoldingFinancialPosition,
} from '../interfaces/IFinancialPosition.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import {
  getEnabledFinancialHistoryDomains,
  needsFinancialHistoryRecovery,
  restoreFinancialHistory as restoreFinancialHistoryFromIndex,
} from '../lib/recovery/index.ts';
import { FinalizedHistoryScheduler } from '../lib/recovery/Scheduler.ts';
import { getMyMiningSeats } from './myMiningSeats.ts';
import {
  calculateAccountValue,
  calculatePositionReturn,
  FinancialPositionBook,
  reduceFinancialPositions,
} from '../lib/financials/index.ts';
import { BitcoinFinancials, valueSatoshisAtRate } from '../lib/financials/BitcoinLocks.ts';
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
import { FinancialCacheTypes, type IFinancialCacheSchemas } from '../lib/db/FinancialCacheTable.ts';

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
  const finalizedAccountReturn = Vue.shallowRef<IFinancialAccountReturnSummary>({
    availability: 'not-applicable',
    basisPoints: 0n,
    eligiblePositionCount: 0,
    investmentPositionCount: 0,
  });
  const financialPositionAggregate = Vue.computed(() => {
    void financialPositionBook.revision;
    const aggregate = reduceFinancialPositions(financialPositionBook.snapshots);
    return { ...aggregate, accountReturn: finalizedAccountReturn.value };
  });
  const walletPositions = Vue.shallowRef<Array<IWalletBalanceFinancialPosition | IWalletHoldingFinancialPosition>>();
  const walletObservation = Vue.shallowRef<IFinancialObservation>();
  const accountSnapshot = Vue.shallowRef<IArgonAccountSnapshot>();
  const liquidNativeBalances = Vue.computed(() => {
    let microgons = 0n;
    let micronots = 0n;

    for (const position of walletPositions.value ?? []) {
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
  const accountReturnSyncState = Vue.ref<'loading' | 'updating' | 'ready' | 'error'>('loading');
  let accountReturnCheckpoint: IFinancialCacheSchemas[FinancialCacheTypes.AccountReturn] | undefined;
  let queuedAccountReturnHeader: IBlockHeaderInfo | undefined;
  let activeAccountReturnBlock = 0;
  let accountReturnRefreshPromise: Promise<void> | undefined;
  let hasConfirmedFinancialHistoryCoverage = false;
  let queuedAccountHeader: IBlockHeaderInfo | undefined;
  let accountRefreshPromise: Promise<void> | undefined;
  let pendingSettlementBlockNumber = 0;
  let treasuryHoldsAreClaimed = false;
  let miningClaimsHolds = false;
  let vaultClaimsHolds = false;
  let walletPositionGeneration = 0;
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

  function publishLiquidHoldings() {
    if (!walletPositions.value || !walletObservation.value) return;

    const refresh = financialPositionBook.beginRefresh('liquid');
    const observedAt = new Date();
    financialPositionBook.publish(refresh, walletPositions.value, {
      ...walletObservation.value,
      observedAt,
    });
  }

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
      results.push(...(await Promise.allSettled([loadVaults(), loadLocks()])));
    }
    for (const result of results) {
      if (result.status === 'rejected') console.error('Unable to load a financial domain', result.reason);
    }
  }

  async function publishWalletPositions(): Promise<void> {
    const snapshot = accountSnapshot.value;
    if (!snapshot) return;
    const generation = ++walletPositionGeneration;

    try {
      const blockNumber = snapshot.observation.blockNumber;
      const hasConfirmedHistoryCoverage = blockNumber !== undefined && (await hasWalletHistoryCoverage(blockNumber));
      const accounts = config.hasExtensionOperations
        ? snapshot.accounts.filter(account => account.address !== wallets.miningBotWallet.address)
        : snapshot.accounts;
      const positions = await walletFinancials.loadPositions({
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
      if (generation !== walletPositionGeneration) return;
      walletPositions.value = positions;
      walletObservation.value = snapshot.observation;
      publishLiquidHoldings();
    } catch (error) {
      if (generation !== walletPositionGeneration) return;
      const message = error instanceof Error ? error.message : 'Unable to publish Argon wallet balances';
      financialPositionBook.fail(financialPositionBook.beginRefresh('liquid'), message);
    }
  }

  async function publishBondPositions(): Promise<void> {
    const snapshot = accountSnapshot.value;
    if (!snapshot) return;

    const refresh = financialPositionBook.beginRefresh('bonds');
    if (!config.hasExtensionTreasury) {
      treasuryHoldsAreClaimed = false;
      financialPositionBook.publish(refresh, [], snapshot.observation);
      return;
    }

    try {
      const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
      if (!account) throw new Error('Default Argon account is missing from the wallet snapshot');

      const positions = await bondFinancials.loadPositions({
        account,
        hasConfirmedBondHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
        liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
        ownedVaultId: myVault.createdVault?.vaultId,
      });
      const didPublish = financialPositionBook.publish(refresh, positions, snapshot.observation);
      if (didPublish) treasuryHoldsAreClaimed = true;
    } catch (error) {
      const didFail = financialPositionBook.invalidate(
        refresh,
        snapshot.observation,
        error instanceof Error ? error.message : 'Unable to publish bond financial positions',
      );
      if (didFail) treasuryHoldsAreClaimed = false;
    }
  }

  async function publishMiningPositions(): Promise<void> {
    const snapshot = accountSnapshot.value;
    if (!snapshot) return;
    const refresh = financialPositionBook.beginRefresh('mining');
    if (!config.hasExtensionOperations) {
      miningClaimsHolds = false;
      financialPositionBook.publish(refresh, [], snapshot.observation);
      return;
    }

    try {
      const blockNumber = snapshot.observation.blockNumber;
      const hasConfirmedHistoryCoverage = blockNumber !== undefined && (await hasWalletHistoryCoverage(blockNumber));
      const positions = await getMiningFinancialsSource().loadPositions({
        accounts: snapshot.accounts,
        miningBotAddress: wallets.miningBotWallet.address,
        hasConfirmedHistoryCoverage,
      });

      // Cohort data changes on its own revision schedule; the current account
      // snapshot supplies the live custody and hold values used by positions.
      const didPublish = financialPositionBook.publish(refresh, positions, snapshot.observation);
      if (didPublish) miningClaimsHolds = true;
    } catch (error) {
      financialPositionBook.invalidate(
        refresh,
        snapshot.observation,
        error instanceof Error ? error.message : 'Unable to publish mining financial positions',
      );
    }
  }

  async function publishVaultPosition(): Promise<void> {
    const snapshot = accountSnapshot.value;
    if (!snapshot) return;

    const refresh = financialPositionBook.beginRefresh('vaulting');
    try {
      const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
      let positions: IFinancialPosition[] = [];
      if (config.hasExtensionOperations) {
        if (!account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');

        positions = await vaultFinancials.loadPositions({
          account,
          liveArgonotRateMicrogons: currency.microgonsPer.ARGNOT,
          hasConfirmedHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
        });
      }

      const didPublish = financialPositionBook.publish(refresh, positions, snapshot.observation);
      if (didPublish) vaultClaimsHolds = Boolean(myVault.createdVault);
    } catch (error) {
      const didFail = financialPositionBook.invalidate(
        refresh,
        snapshot.observation,
        error instanceof Error ? error.message : 'Unable to publish vault financial position',
      );
      if (didFail) vaultClaimsHolds = false;
    }
  }

  async function refreshAccountSnapshot(header: IBlockHeaderInfo): Promise<void> {
    try {
      if (accountSnapshot.value?.observation.blockHash !== header.blockHash) {
        const api = await getBlockWatch().getApi(header);
        accountSnapshot.value = await walletsForArgon.readAccountSnapshot({
          api,
          header,
          includeHolds: config.hasExtensionTreasury || config.hasExtensionOperations,
        });
        // Pending Bitcoin mint can move into the wallet at finalization. Other
        // domains reconcile their holds against this same account snapshot.
        financialPositionBook.advanceSettlementObservation(accountSnapshot.value.observation, ['bitcoin']);
      }
      await Promise.all([publishMiningPositions(), publishVaultPosition(), publishBondPositions()]);
      await publishWalletPositions();
      await publishBitcoinLocks();
      if (isLoaded.value) queueAccountReturnRefresh({ header });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh Argon wallet balances';
      for (const group of ['liquid', 'mining', 'vaulting', 'bonds'] as const) {
        financialPositionBook.fail(financialPositionBook.beginRefresh(group), message);
      }
    }
  }

  function queueAccountRefresh(header = getBlockWatch().finalizedBlockHeader): void {
    if (accountSnapshot.value?.observation.blockHash === header.blockHash && !accountRefreshPromise) return;

    queuedAccountHeader = header;
    accountRefreshPromise ??= (async () => {
      while (queuedAccountHeader) {
        const nextHeader = queuedAccountHeader;
        queuedAccountHeader = undefined;
        await refreshAccountSnapshot(nextHeader);
      }
    })().finally(() => {
      accountRefreshPromise = undefined;
    });
  }

  function queueAccountReturnRefresh({
    header = getBlockWatch().finalizedBlockHeader,
    force = false,
  }: { header?: IBlockHeaderInfo; force?: boolean } = {}): void {
    if (
      !force &&
      (accountReturnCheckpoint?.asOfBlock === header.blockNumber ||
        queuedAccountReturnHeader?.blockNumber === header.blockNumber ||
        activeAccountReturnBlock === header.blockNumber)
    ) {
      return;
    }

    queuedAccountReturnHeader = header;
    accountReturnSyncState.value = 'updating';
    accountReturnRefreshPromise ??= (async () => {
      while (queuedAccountReturnHeader) {
        const nextHeader = queuedAccountReturnHeader;
        queuedAccountReturnHeader = undefined;
        activeAccountReturnBlock = nextHeader.blockNumber;
        try {
          await refreshAccountReturn(nextHeader);
        } finally {
          activeAccountReturnBlock = 0;
        }
      }
    })()
      .catch(error => {
        accountReturnSyncState.value = 'error';
        console.warn('Unable to refresh account RTD', error);
      })
      .finally(() => {
        accountReturnRefreshPromise = undefined;
        if (queuedAccountReturnHeader) {
          queueAccountReturnRefresh({ header: queuedAccountReturnHeader, force: true });
        }
      });
  }

  async function refreshAccountReturn(header: IBlockHeaderInfo): Promise<void> {
    const requiredObservation = {
      observedAt: new Date(header.blockTime),
      blockNumber: header.blockNumber,
      blockHash: header.blockHash,
    };
    const accountValue = calculateAccountValue(financialPositionBook.snapshots, requiredObservation);
    if (accountValue === undefined) return;

    const db = await getDbPromise();
    const addresses = getAccountReturnAddresses();
    const savedCheckpoint = accountReturnCheckpoint;
    const hasCompleteWalletHistory = await hasWalletHistoryCoverage(header.blockNumber);
    const hasCompleteDomainHistory =
      (!config.hasExtensionTreasury && !config.hasExtensionOperations) || hasConfirmedFinancialHistoryCoverage;
    if (!hasCompleteWalletHistory || !hasCompleteDomainHistory) {
      if (savedCheckpoint) {
        publishFinalizedAccountReturn(savedCheckpoint);
        return;
      }

      const baselineCheckpoint = {
        startingBlock: header.blockNumber,
        startingTime: header.blockTime,
        startingValue: accountValue,
        asOfBlock: header.blockNumber,
        basisPoints: 0n,
        isProvisional: true,
      };
      await db.financialCacheTable.upsert(FinancialCacheTypes.AccountReturn, addresses.join(','), baselineCheckpoint);
      publishFinalizedAccountReturn(baselineCheckpoint);
      return;
    }

    const checkpoint = savedCheckpoint?.isProvisional ? undefined : savedCheckpoint;
    let startingBlock = checkpoint?.startingBlock ?? 0;
    let startingTime = checkpoint?.startingTime ?? header.blockTime;
    let startingValue = checkpoint?.startingValue ?? 0n;
    const transfers = await db.walletTransfersTable.fetchExternalFlows({
      walletAddresses: addresses,
      afterBlock: startingBlock,
      throughBlock: header.blockNumber,
    });
    let cashFlows: IAccountCashFlow[] = transfers.map(transfer => ({
      amount:
        transfer.currency === 'argon'
          ? transfer.amount
          : CoreCurrency.convertMicronotToMicrogonAtPrice(
              transfer.amount,
              transfer.microgonsForArgonot || currency.microgonsPer.ARGNOT,
            ),
      occurredAt: transfer.blockTime ?? transfer.createdAt,
    }));

    const bitcoinSnapshot = financialPositionBook.snapshots.find(snapshot => snapshot.group === 'bitcoin');
    for (const position of bitcoinSnapshot?.positions ?? []) {
      if (position.kind !== 'bitcoin-asset') continue;

      if (position.startedAt !== undefined && position.investedCost !== undefined && position.investedCost > 0n) {
        cashFlows.push({ amount: position.investedCost, occurredAt: position.startedAt });
      }

      const { lock } = position;
      const didLeaveAccount = lock.removalReason === 'released' || lock.removalReason === 'spent';
      if (!didLeaveAccount || !position.endedAt || !lock.btcPriceAtRemovalMicrogons) continue;

      const bitcoinNetworkFee = lock.fundingUtxoRecord?.releaseBitcoinNetworkFee ?? 0n;
      const releasedSatoshis = bigIntMax(lock.satoshis - bitcoinNetworkFee, 0n);
      const releasedValue = valueSatoshisAtRate(releasedSatoshis, lock.btcPriceAtRemovalMicrogons);
      if (releasedValue === undefined) continue;

      cashFlows.push({
        amount: -releasedValue,
        occurredAt: position.endedAt,
      });
    }

    if (checkpoint) {
      cashFlows = cashFlows.filter(flow => getCashFlowTime(flow) >= startingTime);
    } else {
      cashFlows.sort((left, right) => getCashFlowTime(left) - getCashFlowTime(right));
      const firstContribution = cashFlows.find(flow => flow.amount > 0n);
      if (!firstContribution) {
        startingBlock = header.blockNumber;
        startingTime = header.blockTime;
        startingValue = accountValue;
        cashFlows.length = 0;
      } else {
        startingTime = getCashFlowTime(firstContribution);
        cashFlows = cashFlows.filter(flow => getCashFlowTime(flow) >= startingTime);
      }
    }

    const result = calculateModifiedDietzReturn({
      startingValue,
      endingValue: accountValue,
      startingDate: startingTime,
      endingDate: header.blockTime,
      cashFlows,
    });
    const nextCheckpoint = {
      startingBlock,
      startingTime,
      startingValue,
      asOfBlock: header.blockNumber,
      basisPoints: result.basisPoints,
    };
    await db.financialCacheTable.upsert(FinancialCacheTypes.AccountReturn, addresses.join(','), nextCheckpoint);

    publishFinalizedAccountReturn(nextCheckpoint);
  }

  function requestSettlementObservation(blockNumber: number): void {
    const finalizedHeader = getBlockWatch().finalizedBlockHeader;
    if (blockNumber <= finalizedHeader.blockNumber) {
      queueAccountRefresh(finalizedHeader);
      return;
    }

    // Latch the first pending observation so finalized state can catch it. Mining
    // revisions may advance every best block; continually moving this target
    // forward would prevent the account snapshot from ever refreshing.
    pendingSettlementBlockNumber ||= blockNumber;
  }

  async function publishBitcoinLocks(summaries?: readonly IBitcoinLockSummary[]): Promise<void> {
    const refresh = financialPositionBook.beginRefresh('bitcoin');
    const btcPrice = currency.priceIndex.btcUsdPrice;
    const argonTargetPrice = currency.priceIndex.argonUsdTargetPrice;
    const hasCurrentPrice = !!btcPrice && !btcPrice.isZero() && !!argonTargetPrice && !argonTargetPrice.isZero();
    const observedAt = new Date();
    const sourceBlock = bitcoinLocks.data.latestArgonBlock;
    await bitcoinLocks.load();
    const positions = bitcoinFinancials.createFinancialPositions({
      summaries: summaries ?? bitcoinLocks.getAllLocks().map(lock => bitcoinLocks.createLockSummary(lock)),
      hasCurrentPrice,
      hasConfirmedHistoryCoverage: hasConfirmedFinancialHistoryCoverage,
    });
    if (positions.length === 0 && accountSnapshot.value) {
      financialPositionBook.publish(refresh, positions, accountSnapshot.value.observation);
      return;
    }

    financialPositionBook.publish(
      refresh,
      positions,
      {
        observedAt,
        ...(sourceBlock ?? {}),
      },
      accountSnapshot.value?.observation,
    );
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
    for (const position of walletPositions.value ?? []) {
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

  const bondsTotalValue = Vue.computed(() => {
    return financialPositionAggregate.value.groupSummaries.bonds.currentValue;
  });
  // Bitcoin Liquid Locks ///////////////////////////////////////////////////////////////////////////////////////////////

  const liquidAllRecords = Vue.ref<IBitcoinLockSummary[]>([]);

  const liquidInvisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => bitcoinLocks.isInactiveForVaultDisplay(l.record));
  });

  const liquidVisibleRecords = Vue.computed<IBitcoinLockSummary[]>(() => {
    return liquidAllRecords.value.filter(l => !bitcoinLocks.isInactiveForVaultDisplay(l.record));
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

  async function loadLocks(): Promise<IBitcoinLockSummary[]> {
    const tmpHodlingInvestments: IPerformanceReturnInput[] = [];
    const lockSummaries: IBitcoinLockSummary[] = [];

    let currentBitcoinDebt = 0n;

    for (const lock of bitcoinLocks.getAllLocks()) {
      const summary = bitcoinLocks.createLockSummary(lock);
      lockSummaries.push(summary);

      if (bitcoinLocks.isLockedStatus(lock)) {
        currentBitcoinDebt += summary.unlockAmount;
      }

      if ((bitcoinLocks.isLockedStatus(lock) || bitcoinLocks.isReleaseStatus(lock)) && lock.ratchets[0]) {
        tmpHodlingInvestments.push({
          startingDate: lock.createdAt,
          startingCapital: summary.startingCapital,
          endingDate: new Date(),
          endingCapital: summary.valueOfBtc,
        });
      }
    }

    liquidCurrentBitcoinDebt.value = currentBitcoinDebt;
    liquidAllRecords.value = lockSummaries;
    liquidHodlingInvestments.value = tmpHodlingInvestments;
    return lockSummaries;
  }

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
      requestSettlementObservation(
        bitcoinLocks.data.latestArgonBlock?.blockNumber ?? getBlockWatch().bestBlockHeader.blockNumber,
      );
      void loadLocks().then(publishBitcoinLocks);
    },
    { deep: true },
  );

  Vue.watch(
    () => bitcoinLocks.data.latestArgonBlock?.blockNumber,
    () => {
      if (!isLoaded.value) return;
      const bitcoinSnapshot = financialPositionBook.snapshots.find(snapshot => snapshot.group === 'bitcoin');
      if (bitcoinSnapshot?.state !== 'stale') return;
      void loadLocks().then(publishBitcoinLocks);
    },
  );

  Vue.watch(
    () => [currency.priceIndex.btcUsdPrice?.toString(), currency.priceIndex.argonUsdTargetPrice?.toString()],
    () => {
      if (!isLoaded.value) return;
      void loadLocks().then(async summaries => {
        await publishBitcoinLocks(summaries);
        publishLiquidHoldings();
      });
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

  wallets.on('balance-change', entry => {
    if (!isLoaded.value) return;
    // Live wallet balances can precede the finalized domain records. Keep the
    // last finalized financial view intact until sync:finalized refreshes all
    // positions at one observation.
    requestSettlementObservation(entry.block.blockNumber);
  });

  walletsForArgon.events.on('sync:finalized', header => {
    if (!isLoaded.value) return;
    if (pendingSettlementBlockNumber && header.blockNumber >= pendingSettlementBlockNumber) {
      pendingSettlementBlockNumber = 0;
      queueAccountRefresh(header);
    }
  });

  walletsForArgon.events.on('history:gap', gap => {
    if (!config.hasExtensionTreasury && !config.hasExtensionOperations) return;

    void restoreFinancialHistory(false, gap.toBlock).catch(() => undefined);
  });

  walletsForArgon.events.on('history:recovered', revisions => {
    const snapshotBlock = accountSnapshot.value?.observation.blockNumber;
    if (!isLoaded.value || !snapshotBlock || revisions.asOfBlock < snapshotBlock) return;
    if (
      lastCoveredWalletSnapshotBlock >= snapshotBlock &&
      lastPublishedArgonotCustodyRevision >= revisions.argonotCustody
    ) {
      void getBlockWatch()
        .getHeaderByBlockNumber(snapshotBlock)
        .then(header => queueAccountReturnRefresh({ header, force: true }))
        .catch(error => {
          accountReturnSyncState.value = 'error';
          console.warn('Unable to refresh recovered account RTD', error);
        });
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
          const currentSnapshotBlock = accountSnapshot.value?.observation.blockNumber;
          if (!currentSnapshotBlock || refreshBlock < currentSnapshotBlock) return;

          if (config.hasExtensionOperations) await publishMiningPositions();
          await publishWalletPositions();
          lastPublishedArgonotCustodyRevision = refreshRevision;
          if (refreshBlock === queuedWalletHistoryBlock && refreshRevision === queuedArgonotCustodyRevision) return;
        }
      })
      .then(async () => {
        const header = await getBlockWatch().getHeaderByBlockNumber(snapshotBlock);
        queueAccountReturnRefresh({ header, force: true });
      })
      .catch(error => {
        accountReturnSyncState.value = 'error';
        console.warn('Unable to refresh recovered account RTD', error);
      })
      .finally(() => {
        walletHistoryRefreshPromise = undefined;
      });
  });

  Vue.watch(
    () => [argonBonds.data.bondLots, argonBonds.data.bondHistory],
    () => {
      if (!config.hasExtensionTreasury) return;
      requestSettlementObservation(getBlockWatch().bestBlockHeader.blockNumber);
      void publishBondPositions().then(() => publishWalletPositions());
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
      requestSettlementObservation(getBlockWatch().bestBlockHeader.blockNumber);
      void publishVaultPosition().then(() => publishWalletPositions());
    },
  );

  Vue.watch(
    () => currency.microgonsPer.ARGNOT,
    () => {
      if (!isLoaded.value) return;
      void Promise.all([publishBondPositions(), publishMiningPositions(), publishVaultPosition()]).then(() =>
        publishWalletPositions(),
      );
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionOperations ? getMyMiningSeatsSource().financialRevision : 0),
    () => {
      if (!isLoaded.value || !config.hasExtensionOperations) return;
      const sourceBlockNumber = getMyMiningSeatsSource().serverState.argonLocalNodeBlockNumber;
      requestSettlementObservation(sourceBlockNumber || getBlockWatch().bestBlockHeader.blockNumber);
      if (sourceBlockNumber && sourceBlockNumber > (accountSnapshot.value?.observation.blockNumber ?? 0)) return;

      void publishMiningPositions().then(() => publishWalletPositions());
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

        // The basic app snapshot omits hold details. Reload the same finalized
        // block when a domain activates so its positions can claim those holds.
        accountSnapshot.value = undefined;
        await refreshAccountSnapshot(getBlockWatch().finalizedBlockHeader);
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

  function getAccountReturnAddresses(): string[] {
    return [...walletsForArgon.ownedAddresses].sort();
  }

  async function loadAccountReturnCheckpoint(): Promise<void> {
    const addresses = getAccountReturnAddresses();
    const checkpoint = await (
      await getDbPromise()
    ).financialCacheTable.get(FinancialCacheTypes.AccountReturn, addresses.join(','));
    if (!checkpoint) return;

    if (checkpoint.asOfBlock > getBlockWatch().finalizedBlockHeader.blockNumber) return;

    publishFinalizedAccountReturn(checkpoint);
  }

  function publishFinalizedAccountReturn(checkpoint: IFinancialCacheSchemas[FinancialCacheTypes.AccountReturn]): void {
    accountReturnCheckpoint = checkpoint;
    finalizedAccountReturn.value = {
      availability: 'available',
      basisPoints: checkpoint.basisPoints,
      percent: Number(checkpoint.basisPoints) / 100,
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    };
    accountReturnSyncState.value = checkpoint.isProvisional ? 'updating' : 'ready';
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
    await loadAccountReturnCheckpoint().catch(error => {
      console.warn('Unable to restore finalized account RTD', error);
    });
    await loadEnabledDomainSources();
    const domainSourcesReadyAt = performance.now();

    if (!config.hasExtensionTreasury) {
      vaultsIsLoaded.value = true;
    }
    await refreshAccountSnapshot(getBlockWatch().finalizedBlockHeader);
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
    queueAccountReturnRefresh({ force: accountReturnCheckpoint?.isProvisional });
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
    });
    if (needsRecovery) {
      await restoreFinancialHistory(false, targetBlock);
      return;
    }

    hasConfirmedFinancialHistoryCoverage = true;
    historyRecovery.value = { state: 'ready', recoveredBlockCount: 0 };
    queueAccountReturnRefresh({ force: true });
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
      await Promise.all([publishVaultPosition(), publishBondPositions()]);
      await publishWalletPositions();
      const summaries = await loadLocks();
      await publishBitcoinLocks(summaries);
      queueAccountReturnRefresh({ header: getBlockWatch().finalizedBlockHeader, force: true });
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

    liquidAllRecords,
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
    accountReturnSyncState,
    restoreFinancialHistory,
  };
});

function getCashFlowTime(cashFlow: IAccountCashFlow): number {
  if (cashFlow.occurredAt instanceof Date) return cashFlow.occurredAt.getTime();
  if (typeof cashFlow.occurredAt === 'number') return cashFlow.occurredAt;
  return new Date(cashFlow.occurredAt).getTime();
}
