import { defineStore } from 'pinia';
import * as Vue from 'vue';
import { getWalletHistoryRecovery, getWalletsForArgon, useWallets } from './wallets.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getCurrency } from './currency.ts';
import { getArgonBonds } from './argonBonds.ts';
import { getBlockWatch } from './mainchain.ts';
import {
  bigIntMax,
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
  type IVaultFinancialPosition,
  type IWalletBalanceFinancialPosition,
  type IWalletHoldingFinancialPosition,
} from '../interfaces/IFinancialPosition.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import {
  getEnabledFinancialHistoryDomains,
  restoreFinancialHistory as restoreFinancialHistoryFromIndex,
} from '../lib/recovery/index.ts';
import { FinalizedHistoryScheduler } from '../lib/recovery/Scheduler.ts';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { FinancialPositionBook, reduceFinancialPositions } from '../lib/financials/index.ts';
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
  const walletPositions = Vue.shallowRef<Array<IWalletBalanceFinancialPosition | IWalletHoldingFinancialPosition>>();
  const walletObservation = Vue.shallowRef<IFinancialObservation>();
  const accountSnapshot = Vue.shallowRef<IArgonAccountSnapshot>();
  const historyRecovery = Vue.ref<{
    state: 'checking' | 'restoring' | 'waiting' | 'ready' | 'error';
    recoveredBlockCount: number;
    message?: string;
  }>({ state: 'checking', recoveredBlockCount: 0 });
  let queuedAccountHeader: IBlockHeaderInfo | undefined;
  let accountRefreshPromise: Promise<void> | undefined;
  let pendingSettlementBlockNumber = 0;
  let treasuryHoldsAreClaimed = false;
  let miningClaimsHolds = false;
  let miningCustodyClaimedMicronots = 0n;
  let vaultClaimsHolds = false;
  let walletPositionGeneration = 0;
  let lastCoveredWalletSnapshotBlock = 0;
  let lastPublishedArgonotCustodyRevision = 0;
  let queuedWalletHistoryBlock = 0;
  let queuedArgonotCustodyRevision = 0;
  let walletHistoryCoverage: { blockNumber: number; promise: Promise<boolean> } | undefined;
  let walletHistoryRefreshPromise: Promise<void> | undefined;
  const finalizedHistoryScheduler = new FinalizedHistoryScheduler(async (finalizedBlockNumber, force) => {
    if (!isLoaded.value || (!force && !config.hasExtensionTreasury && !config.hasExtensionOperations)) {
      return finalizedBlockNumber;
    }
    return runFinancialHistoryRecovery(force, finalizedBlockNumber);
  });

  function publishLiquidHoldings() {
    if (!walletPositions.value || !walletObservation.value) return;

    const refresh = financialPositionBook.beginRefresh('liquid');
    const externalPositions = wallets.externalFinancialPositions;
    const observedAt = new Date();
    financialPositionBook.publish(refresh, [...walletPositions.value, ...externalPositions], {
      ...walletObservation.value,
      observedAt,
    });
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
      const positions = await walletFinancials.loadPositions({
        ...snapshot,
        claimedHolds: {
          treasury: treasuryHoldsAreClaimed,
          miningSlot: miningClaimsHolds,
          vaults: vaultClaimsHolds,
        },
        claimedMicronotsByAccount: new Map([[wallets.miningBotWallet.address, miningCustodyClaimedMicronots]]),
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
        hasConfirmedBondHistoryCoverage: historyRecovery.value.state === 'ready',
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
      miningCustodyClaimedMicronots = 0n;
      financialPositionBook.publish(refresh, [], snapshot.observation);
      return;
    }

    try {
      const seats = getMyMiningSeatsSource();
      const blockNumber = snapshot.observation.blockNumber;
      const hasConfirmedHistoryCoverage = blockNumber !== undefined && (await hasWalletHistoryCoverage(blockNumber));
      const positions = await getMiningFinancialsSource().loadPositions({
        accounts: snapshot.accounts,
        miningBotAddress: wallets.miningBotWallet.address,
        hasConfirmedHistoryCoverage,
      });
      const miningBotAccount = snapshot.accounts.find(account => account.address === wallets.miningBotWallet.address)!;
      const miningBotHeldMicronots = miningBotAccount.micronotHolds
        .filter(hold => hold.id.isMiningSlot)
        .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
      const activeCustodyMicronots = positions.reduce((sum, position) => {
        return position.kind === 'mining-argonot' && position.lifecycle !== 'completed'
          ? sum + position.micronots
          : sum;
      }, 0n);
      const claimedCustodyMicronots = bigIntMax(activeCustodyMicronots - miningBotHeldMicronots, 0n);
      if (positions.length === 0) {
        const didPublish = financialPositionBook.publish(refresh, positions, snapshot.observation);
        if (didPublish) {
          miningClaimsHolds = true;
          miningCustodyClaimedMicronots = claimedCustodyMicronots;
        }
        return;
      }

      const sourceBlockNumber = seats.serverState.argonLocalNodeBlockNumber;
      const sourceObservation: IFinancialObservation = {
        observedAt: seats.serverState.argonBlocksLastUpdatedAt ?? snapshot.observation.observedAt,
        ...(sourceBlockNumber ? { blockNumber: sourceBlockNumber } : {}),
        ...(sourceBlockNumber === snapshot.observation.blockNumber
          ? { blockHash: snapshot.observation.blockHash }
          : {}),
      };
      const didPublish = financialPositionBook.publish(refresh, positions, sourceObservation, snapshot.observation);
      if (didPublish) {
        miningClaimsHolds = true;
        miningCustodyClaimedMicronots = claimedCustodyMicronots;
      }
    } catch (error) {
      const didFail = financialPositionBook.invalidate(
        refresh,
        snapshot.observation,
        error instanceof Error ? error.message : 'Unable to publish mining financial positions',
      );
      if (didFail) {
        miningClaimsHolds = false;
        miningCustodyClaimedMicronots = 0n;
      }
    }
  }

  async function publishVaultPosition(): Promise<void> {
    const snapshot = accountSnapshot.value;
    if (!snapshot) return;

    const refresh = financialPositionBook.beginRefresh('vaulting');
    try {
      const account = snapshot.accounts.find(entry => entry.address === wallets.defaultArgonWallet.address);
      let positions: IVaultFinancialPosition[] = [];
      if (config.hasExtensionOperations) {
        if (!account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');

        positions = await vaultFinancials.loadPositions({
          account,
          hasConfirmedHistoryCoverage: historyRecovery.value.state === 'ready',
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
        financialPositionBook.advanceSettlementObservation(accountSnapshot.value.observation, [
          'liquid',
          'mining',
          'vaulting',
          'bonds',
          'bitcoin',
        ]);
      }
      await Promise.all([publishMiningPositions(), publishVaultPosition(), publishBondPositions()]);
      await publishWalletPositions();
      await publishBitcoinLocks();
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

  function requestSettlementObservation(blockNumber: number): void {
    const finalizedHeader = getBlockWatch().finalizedBlockHeader;
    if (blockNumber <= finalizedHeader.blockNumber) {
      queueAccountRefresh(finalizedHeader);
      return;
    }

    pendingSettlementBlockNumber = Math.max(pendingSettlementBlockNumber, blockNumber);
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
      hasConfirmedHistoryCoverage: historyRecovery.value.state === 'ready',
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

  async function publishStableSwapPosition(): Promise<void> {
    const refresh = financialPositionBook.beginRefresh('stableSwaps');
    if (!config.hasExtensionTreasury) {
      financialPositionBook.publish(refresh, [], { observedAt: new Date() });
      return;
    }
    if (wallets.ethereumWallet.fetchErrorMsg) {
      financialPositionBook.fail(refresh, wallets.ethereumWallet.fetchErrorMsg);
      return;
    }

    try {
      const positions = await stableSwapFinancials.loadPositions({
        wallet: wallets.ethereumWallet,
      });
      const observedAt = new Date();
      financialPositionBook.publish(refresh, positions, {
        observedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load stable swap history';
      financialPositionBook.fail(refresh, message);
    }
  }

  async function refreshStableSwapPosition(): Promise<void> {
    if (!config.hasExtensionTreasury) {
      await publishStableSwapPosition();
      return;
    }

    try {
      if (stableSwaps.marketSnapshot) {
        await stableSwaps.refreshWalletSnapshot();
      } else {
        await stableSwaps.load();
      }
      if (!isLoaded.value) await publishStableSwapPosition();
    } catch (error) {
      financialPositionBook.fail(
        financialPositionBook.beginRefresh('stableSwaps'),
        error instanceof Error ? error.message : 'Unable to load stable swap history',
      );
    }
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
    const bitcoinSnapshot = financialPositionBook.snapshots.find(snapshot => snapshot.group === 'bitcoin');
    const alignedPendingMint = bitcoinSnapshot?.state === 'ready' ? savingsTotalPending.value : 0n;
    return alignedPendingMint + savingsTotalReadyToUse.value;
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
    () => [wallets.ethereumWallet, wallets.baseWallet],
    () => {
      if (!isLoaded.value) return;
      publishLiquidHoldings();
    },
    { deep: true },
  );

  Vue.watch(
    () => [
      wallets.ethereumWallet.address,
      wallets.ethereumWallet.availableMicrogons,
      wallets.ethereumWallet.reservedMicrogons,
      wallets.ethereumWallet.fetchErrorMsg,
    ],
    ([address], [previousAddress]) => {
      if (!isLoaded.value) return;
      if (
        address !== previousAddress ||
        (!stableSwaps.marketSnapshot && wallets.ethereumWallet.availableMicrogons > 0n)
      ) {
        void refreshStableSwapPosition();
        return;
      }

      void publishStableSwapPosition();
    },
  );

  Vue.watch(
    () => [stableSwaps.walletSnapshot, stableSwaps.marketSnapshot],
    () => {
      if (!isLoaded.value) return;
      void publishStableSwapPosition();
    },
  );

  wallets.on('balance-change', entry => {
    if (!isLoaded.value) return;
    financialPositionBook.advanceSettlementObservation(
      {
        observedAt: new Date(entry.block.blockTime),
        blockNumber: entry.block.blockNumber,
        blockHash: entry.block.blockHash,
      },
      ['mining', 'bitcoin'],
    );
    requestSettlementObservation(entry.block.blockNumber);
  });

  walletsForArgon.events.on('sync:finalized', header => {
    if (!isLoaded.value) return;
    if (pendingSettlementBlockNumber && header.blockNumber >= pendingSettlementBlockNumber) {
      pendingSettlementBlockNumber = 0;
      queueAccountRefresh(header);
    }
    if (
      getEnabledFinancialHistoryDomains({
        force: false,
        hasExtensionTreasury: config.hasExtensionTreasury,
        hasExtensionOperations: config.hasExtensionOperations,
        walletAccountsHadPreviousLife: config.walletAccountsHadPreviousLife,
      }).length
    ) {
      finalizedHistoryScheduler.queue(header.blockNumber);
    }
  });

  walletsForArgon.events.on('history:recovered', revisions => {
    const snapshotBlock = accountSnapshot.value?.observation.blockNumber;
    if (!isLoaded.value || !snapshotBlock || revisions.asOfBlock < snapshotBlock) return;
    if (
      lastCoveredWalletSnapshotBlock >= snapshotBlock &&
      lastPublishedArgonotCustodyRevision >= revisions.argonotCustody
    ) {
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
      .finally(() => {
        walletHistoryRefreshPromise = undefined;
      });
  });

  Vue.watch(
    () => [argonBonds.data.bondLots, argonBonds.data.bondHistory],
    () => {
      if (!isLoaded.value || !config.hasExtensionTreasury) return;
      requestSettlementObservation(getBlockWatch().bestBlockHeader.blockNumber);
      void publishBondPositions().then(() => publishWalletPositions());
    },
  );

  Vue.watch(
    () => [myVault.createdVault, myVault.data.pendingCollectRevenue],
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
      void Promise.all([publishBondPositions(), publishMiningPositions()]).then(() => publishWalletPositions());
    },
  );

  Vue.watch(
    () => (config.isLoaded && config.hasExtensionOperations ? getMyMiningSeatsSource().financialRevision : 0),
    () => {
      if (!isLoaded.value || !config.hasExtensionOperations) return;
      requestSettlementObservation(
        getMyMiningSeatsSource().serverState.argonLocalNodeBlockNumber || getBlockWatch().bestBlockHeader.blockNumber,
      );
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

        // The basic app snapshot omits hold details. Reload the same finalized
        // block when a domain activates so its positions can claim those holds.
        accountSnapshot.value = undefined;
        await refreshAccountSnapshot(getBlockWatch().finalizedBlockHeader);
        if (config.hasExtensionTreasury || config.hasExtensionOperations) {
          void restoreFinancialHistory().catch(() => undefined);
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
    setFinancialScope();
    await config.isLoadedPromise;
    await Promise.all([wallets.isLoadedPromise, currency.isLoadedPromise]);
    setFinancialScope();
    await loadEnabledDomainSources();

    savingsIsLoaded.value = true;

    if (!config.hasExtensionTreasury) {
      vaultsIsLoaded.value = true;
    }
    await refreshAccountSnapshot(getBlockWatch().finalizedBlockHeader);
    if (config.hasExtensionTreasury) {
      await refreshStableSwapPosition();
    } else {
      await publishStableSwapPosition();
    }
    if (config.hasExtensionTreasury) startLockSummaryProgressRefresh();

    isLoaded.value = true;
    if (config.hasExtensionTreasury || config.hasExtensionOperations) {
      void restoreFinancialHistory().catch(() => undefined);
    } else if (config.walletAccountsHadPreviousLife) {
      void restoreFinancialHistory(true).catch(() => undefined);
    } else {
      historyRecovery.value = { state: 'ready', recoveredBlockCount: 0 };
    }
  }

  function restoreFinancialHistory(force = false, minimumAsOfBlock?: number): Promise<void> {
    const targetBlock = minimumAsOfBlock ?? getBlockWatch().finalizedBlockHeader.blockNumber;
    return finalizedHistoryScheduler.runNow(targetBlock, force);
  }

  async function runFinancialHistoryRecovery(force: boolean, targetBlock: number): Promise<number> {
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
          historyRecovery.value = { state: 'checking', recoveredBlockCount: 0 };
        },
        onProgress(recoveredBlockCount) {
          historyRecovery.value = {
            state: 'restoring',
            recoveredBlockCount,
          };
        },
      });
      historyRecovery.value = {
        state: result.asOfBlock >= targetBlock ? 'ready' : 'waiting',
        recoveredBlockCount: result.importedBlockCount,
        ...(result.asOfBlock < targetBlock
          ? {
              message: `Investment history is indexed through block ${result.asOfBlock.toLocaleString()} and is still catching up`,
            }
          : {}),
      };
      await Promise.all([publishVaultPosition(), publishBondPositions()]);
      await publishWalletPositions();
      const summaries = await loadLocks();
      await publishBitcoinLocks(summaries);
      return result.asOfBlock;
    } catch (error) {
      historyRecovery.value = {
        state: 'error',
        recoveredBlockCount: historyRecovery.value.recoveredBlockCount,
        message: error instanceof Error ? error.message : 'Unable to restore investment history',
      };
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

    financialPositionAggregate,
    historyRecovery,
    restoreFinancialHistory,
  };
});
