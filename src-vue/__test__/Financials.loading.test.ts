import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { type ArgonQueryClient, BondLot, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import {
  type FrameSupportTokensMiscIdAmountRuntimeHoldReason,
  getOfflineRegistry,
  type PalletTreasuryBondLot,
} from '@argonprotocol/mainchain';
import type { IFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import type { IArgonAccountSnapshot } from '../lib/WalletsForArgon.ts';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import type { IMiningCohortFinancialRecord } from '../interfaces/db/ICohortFrameRecord.ts';

const mocks = vi.hoisted(() => {
  const wallet = (address: string) => ({
    address,
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
    otherTokens: [],
    fetchErrorMsg: '',
  });
  const fetchArgonotCustody = vi.fn(async () => []);

  return {
    argonBonds: {
      data: { bondLots: [] as BondLot[], bondHistory: [] },
      completedBondHistory: [],
      miningFrames: { getFrameDate: vi.fn(() => new Date('2026-07-16T12:00:00Z')) },
      load: vi.fn<() => Promise<void>>(),
      getOwnBondLots: vi.fn<(clientAt: ArgonQueryClient) => Promise<BondLot[]>>(),
      createFinancialPositions: vi.fn(() => []),
    },
    bitcoinLocks: {
      data: { locksByUtxoId: {}, pendingLocks: [], latestArgonBlock: undefined },
      recovery: {},
      load: vi.fn<() => Promise<void>>(),
      getAllLocks: vi.fn((): object[] => []),
      createLockSummaryAt: vi.fn(async (_lock: object, _api: object) => createBitcoinSummary(0n)),
      isLockedStatus: vi.fn(() => true),
      isReleaseStatus: vi.fn(() => false),
      isInactiveForVaultDisplay: vi.fn(() => false),
      refreshLockSummary: vi.fn(),
    },
    blockWatch: {
      bestBlockHeader: { blockNumber: 1, blockHash: '0x1', blockTime: Date.parse('2026-07-16T12:00:00Z') },
      finalizedBlockHeader: { blockNumber: 1, blockHash: '0x1', blockTime: Date.parse('2026-07-16T12:00:00Z') },
      latestHeaders: [{ blockNumber: 1, blockHash: '0x1', blockTime: Date.parse('2026-07-16T12:00:00Z') }],
      getApi: vi.fn(async (_header: IBlockHeaderInfo) => ({})),
      getHeaderByBlockNumber: vi.fn(async (blockNumber: number) => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        blockTime: Date.parse('2026-07-16T12:00:00Z') + (blockNumber - 1) * 60_000,
      })),
    },
    config: {
      isLoadedPromise: Promise.resolve(),
      hasExtensionTreasury: false,
      hasExtensionOperations: false,
      hasActivatedStableSwaps: false,
      walletAccountsHadPreviousLife: false,
    },
    currency: {
      isLoadedPromise: Promise.resolve(),
      microgonsPer: { ARGNOT: 0n },
      priceIndex: {},
      usdTarget: 0,
      convertMicronotTo: vi.fn(() => 0n),
      convertOtherToMicrogon: vi.fn(() => 0n),
    },
    myMiningSeats: {
      isLoadedPromise: Promise.resolve(),
      financialRevision: 0,
      serverState: { argonLocalNodeBlockNumber: 0 },
    },
    miningFinancials: {
      loadPositions: vi.fn(async (): Promise<IFinancialPosition[]> => []),
    },
    myVault: {
      createdVault: undefined,
      data: {
        pendingCollectRevenue: 0n,
        argonotCommitment: {
          committedMicronots: 0n,
          encumberedMicronots: 0n,
        },
      },
      history: {
        loadPositionHistory: vi.fn(async () => ({ capital: [], revenue: [] })),
      },
      load: vi.fn<() => Promise<void>>(),
    },
    stableSwaps: {
      walletSnapshot: undefined,
      marketSnapshot: undefined,
      load: vi.fn<() => Promise<void>>(),
      refreshWalletSnapshot: vi.fn<() => Promise<void>>(),
    },
    vaults: { vaultsById: {}, load: vi.fn<() => Promise<void>>() },
    vaultingStats: {
      isLoadedPromise: Promise.resolve(),
      microgonValueInVaults: 0n,
      argonBurnCapacity: 0,
    },
    walletHistoryRecovery: { hasCompleteCoverage: vi.fn(async () => false) },
    db: {},
    wallets: {
      isLoadedPromise: Promise.resolve(),
      defaultArgonWallet: wallet('5default'),
      miningBotWallet: wallet('5miner'),
      operationalWallet: wallet('5operational'),
      ethereumWallet: { ...wallet('0xethereum'), balanceUpdatedAt: new Date('2026-07-17T12:00:00Z') },
      baseWallet: { ...wallet('0xbase'), balanceUpdatedAt: new Date('2026-07-17T12:00:00Z') },
      ethereumFinancialPositions: [],
      baseFinancialPositions: [],
      on: vi.fn(),
    },
    walletsForArgon: {
      events: { on: vi.fn() },
      dbPromise: Promise.resolve({
        walletTransfersTable: {
          argonotCustodyRevision: 0,
          fetchArgonotCustody,
        },
      }),
      createFinancialPositions: vi.fn(async () => []),
      defaultArgonWallet: { address: '5default' },
      miningBotWallet: { address: '5miner' },
      operationalWallet: { address: '5operational' },
      legacyMiningHoldAddress: '',
      ownedAddresses: ['5default', '5miner', '5operational'],
      readAccountSnapshot: vi.fn(
        async ({ header }: { header: IBlockHeaderInfo }): Promise<IArgonAccountSnapshot> => ({
          accounts: [
            {
              address: '5default',
              wallet: { address: '5default' } as WalletForArgon,
              availableMicrogons: 0n,
              reservedMicrogons: 0n,
              availableMicronots: 0n,
              reservedMicronots: 0n,
              microgonHolds: [],
              micronotHolds: [],
            },
          ],
          observation: {
            observedAt: new Date(header.blockTime),
            blockNumber: header.blockNumber,
            blockHash: header.blockHash,
          },
        }),
      ),
      fetchArgonotCustody,
    },
    restoreFinancialHistory: vi.fn(async () => ({ asOfBlock: 1, importedBlockCount: 0 })),
    needsFinancialHistoryRecovery: vi.fn(async () => true),
  };
});

vi.mock('../stores/wallets.ts', () => ({
  getWalletHistoryRecovery: () => mocks.walletHistoryRecovery,
  getWalletsForArgon: () => mocks.walletsForArgon,
  useWallets: () => mocks.wallets,
}));
vi.mock('../stores/bitcoin.ts', () => ({ getBitcoinLocks: () => mocks.bitcoinLocks }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => mocks.currency }));
vi.mock('../stores/argonBonds.ts', () => ({ getArgonBonds: () => mocks.argonBonds }));
vi.mock('../stores/mainchain.ts', () => ({ getBlockWatch: () => mocks.blockWatch }));
vi.mock('../stores/vaults.ts', () => ({
  getMyVault: () => mocks.myVault,
  getVaults: () => mocks.vaults,
}));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: vi.fn(async () => mocks.db) }));
vi.mock('../stores/myMiningSeats.ts', () => ({ getMyMiningSeats: () => mocks.myMiningSeats }));
vi.mock('../lib/financials/MyMiningSeats.ts', () => ({
  MiningFinancials: class {
    loadPositions = mocks.miningFinancials.loadPositions;
  },
}));
vi.mock('../stores/vaultingStats.ts', () => ({ useVaultingStats: () => mocks.vaultingStats }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => mocks.config }));
vi.mock('../stores/stableSwaps.ts', () => ({ useStableSwaps: () => mocks.stableSwaps }));
vi.mock('../lib/recovery/index.ts', () => ({
  getEnabledFinancialHistoryDomains: vi.fn(() => []),
  needsFinancialHistoryRecovery: mocks.needsFinancialHistoryRecovery,
  restoreFinancialHistory: mocks.restoreFinancialHistory,
}));

import { useFinancials } from '../stores/financials.ts';

describe('financials store lifecycle', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mocks.config.isLoadedPromise = Promise.resolve();
    mocks.config.hasExtensionTreasury = false;
    mocks.config.hasExtensionOperations = false;
    mocks.config.hasActivatedStableSwaps = false;
    mocks.config.walletAccountsHadPreviousLife = false;
    mocks.wallets.isLoadedPromise = Promise.resolve();
    mocks.currency.isLoadedPromise = Promise.resolve();
    mocks.currency.microgonsPer.ARGNOT = 0n;
    mocks.argonBonds.load.mockResolvedValue();
    mocks.argonBonds.data.bondLots = [];
    mocks.argonBonds.data.bondHistory = [];
    mocks.argonBonds.getOwnBondLots.mockImplementation(async () => mocks.argonBonds.data.bondLots);
    mocks.argonBonds.getOwnBondLots.mockClear();
    mocks.argonBonds.miningFrames.getFrameDate.mockClear();
    mocks.bitcoinLocks.load.mockResolvedValue();
    mocks.bitcoinLocks.load.mockClear();
    mocks.bitcoinLocks.getAllLocks.mockReturnValue([]);
    mocks.bitcoinLocks.getAllLocks.mockClear();
    mocks.bitcoinLocks.createLockSummaryAt.mockImplementation(async () => createBitcoinSummary(0n));
    mocks.bitcoinLocks.createLockSummaryAt.mockClear();
    mocks.bitcoinLocks.isLockedStatus.mockReturnValue(true);
    mocks.bitcoinLocks.isReleaseStatus.mockReturnValue(false);
    mocks.vaults.load.mockResolvedValue();
    mocks.myVault.load.mockResolvedValue();
    mocks.miningFinancials.loadPositions.mockResolvedValue([]);
    mocks.miningFinancials.loadPositions.mockClear();
    mocks.stableSwaps.load.mockResolvedValue();
    mocks.stableSwaps.load.mockClear();
    mocks.stableSwaps.refreshWalletSnapshot.mockResolvedValue();
    mocks.restoreFinancialHistory.mockResolvedValue({ asOfBlock: 1, importedBlockCount: 0 });
    mocks.restoreFinancialHistory.mockClear();
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(true);
    mocks.needsFinancialHistoryRecovery.mockClear();
    mocks.blockWatch.bestBlockHeader = {
      blockNumber: 1,
      blockHash: '0x1',
      blockTime: Date.parse('2026-07-16T12:00:00Z'),
    };
    mocks.blockWatch.finalizedBlockHeader = {
      blockNumber: 1,
      blockHash: '0x1',
      blockTime: Date.parse('2026-07-16T12:00:00Z'),
    };
    mocks.blockWatch.latestHeaders = [mocks.blockWatch.finalizedBlockHeader];
    mocks.blockWatch.getApi.mockClear();
    mocks.blockWatch.getHeaderByBlockNumber.mockClear();
    mocks.walletHistoryRecovery.hasCompleteCoverage.mockResolvedValue(false);
    mocks.walletHistoryRecovery.hasCompleteCoverage.mockClear();
    mocks.walletsForArgon.events.on.mockClear();
    mocks.walletsForArgon.readAccountSnapshot.mockImplementation(async ({ header }: { header: IBlockHeaderInfo }) => {
      return createAccountSnapshot(header);
    });
    mocks.walletsForArgon.readAccountSnapshot.mockClear();
    mocks.walletsForArgon.fetchArgonotCustody.mockResolvedValue([]);
    mocks.walletsForArgon.fetchArgonotCustody.mockClear();
    mocks.wallets.on.mockClear();
    mocks.myVault.history.loadPositionHistory.mockResolvedValue({ capital: [], revenue: [] });
    mocks.myVault.history.loadPositionHistory.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    disposePinia(pinia);
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'configuration',
      message: 'configuration failed',
      fail: () => {
        mocks.config.isLoadedPromise = Promise.reject(new Error('configuration failed'));
      },
    },
    {
      name: 'wallets',
      message: 'wallet loading failed',
      fail: () => {
        mocks.wallets.isLoadedPromise = Promise.reject(new Error('wallet loading failed'));
      },
    },
  ])('settles public loading state when $name fails', async ({ fail, message }) => {
    fail();

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.historyRecovery).toEqual({
        state: 'error',
        recoveredBlockCount: 0,
        message,
      });
    });
    expect(financials.savingsIsLoaded).toBe(true);
    expect(financials.vaultsIsLoaded).toBe(true);
    expect(financials.financialPositionAggregate.readiness).toBe('error');
  });

  it.each([
    {
      group: 'liquid' as const,
      fail: () => {
        mocks.walletHistoryRecovery.hasCompleteCoverage.mockResolvedValue(true);
        mocks.walletsForArgon.fetchArgonotCustody.mockRejectedValueOnce(new Error('wallet loading failed'));
      },
    },
    {
      group: 'mining' as const,
      fail: () => {
        mocks.config.hasExtensionOperations = true;
        mocks.miningFinancials.loadPositions.mockRejectedValueOnce(new Error('mining loading failed'));
      },
    },
    {
      group: 'vaulting' as const,
      fail: () => {
        mocks.config.hasExtensionOperations = true;
        mocks.myVault.history.loadPositionHistory.mockRejectedValueOnce(new Error('vault loading failed'));
      },
    },
    {
      group: 'bonds' as const,
      fail: () => {
        mocks.config.hasExtensionTreasury = true;
        mocks.argonBonds.load.mockRejectedValue(new Error('bond loading failed'));
      },
    },
    {
      group: 'bitcoin' as const,
      fail: () => {
        mocks.config.hasExtensionTreasury = true;
        mocks.bitcoinLocks.getAllLocks.mockImplementationOnce(() => {
          throw new Error('Bitcoin loading failed');
        });
      },
    },
  ])('keeps other mainchain groups available when $group fails', async ({ group, fail }) => {
    fail();

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries[group].state).toBe('error');
    });
    for (const currentGroup of ['liquid', 'mining', 'vaulting', 'bonds', 'bitcoin'] as const) {
      if (currentGroup === group) continue;
      expect(financials.financialPositionAggregate.groupSummaries[currentGroup].state).toBe('ready');
    }
    expect(financials.financialPositionAggregate.readiness).toBe('partial');
  });

  it('does not load stable swaps before the feature is activated', async () => {
    mocks.config.hasExtensionTreasury = true;

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.ethereum.state).toBe('ready');
    });
    expect(mocks.stableSwaps.load).not.toHaveBeenCalled();
  });

  it('keeps bonds and pending mint correctly classified through a best-block handoff', async () => {
    const registry = getOfflineRegistry();
    const finalized = mocks.blockWatch.finalizedBlockHeader;
    const best1 = {
      blockNumber: 2,
      blockHash: '0xbest2',
      blockTime: Date.parse('2026-07-16T12:01:00Z'),
    };
    const best2 = {
      blockNumber: 3,
      blockHash: '0xbest3',
      blockTime: Date.parse('2026-07-16T12:02:00Z'),
    };
    const runtimeLot = registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
      owner: `0x${'11'.repeat(32)}`,
      program: { Argonot: null },
      bonds: 20,
      createdFrameId: 1,
      participatedFrames: 0,
      lastFrameEarningsFrameId: 1,
      lastFrameEarnings: 0,
      cumulativeEarnings: 0,
      releaseFrameId: null,
      releaseReason: null,
    });
    const treasuryHold = registry.createType<FrameSupportTokensMiscIdAmountRuntimeHoldReason>(
      'FrameSupportTokensMiscIdAmountRuntimeHoldReason',
      {
        id: { Treasury: 'ContributedToTreasury' },
        amount: 20_000_000n,
      },
    );
    const pendingSummary = createBitcoinSummary(50n);
    const mintedSummary = createBitcoinSummary(0n);
    const firstSnapshot = createAccountSnapshot(best1, 50n);
    const secondSnapshot = createAccountSnapshot(best2, 100n);
    for (const snapshot of [firstSnapshot, secondSnapshot]) {
      snapshot.accounts[0].reservedMicronots = 20_000_000n;
      snapshot.accounts[0].micronotHolds = [treasuryHold];
    }

    mocks.config.hasExtensionTreasury = true;
    mocks.currency.microgonsPer.ARGNOT = 1_000_000n;
    mocks.currency.priceIndex = {
      btcUsdPrice: { isZero: () => false },
      argonUsdTargetPrice: { isZero: () => false },
    };
    const finalizedClient = {};
    const best1Client = {};
    const best2Client = {};
    mocks.blockWatch.bestBlockHeader = best1;
    mocks.blockWatch.latestHeaders = [finalized, best1];
    mocks.blockWatch.getApi.mockImplementation(async header => {
      if (header.blockHash === best1.blockHash) return best1Client;
      if (header.blockHash === best2.blockHash) return best2Client;
      return finalizedClient;
    });
    const bondLot = BondLot.fromRuntime(1, runtimeLot, runtimeLot.owner.toString());
    mocks.argonBonds.data.bondLots = [];
    mocks.argonBonds.getOwnBondLots.mockImplementation(async clientAt => {
      return clientAt === best1Client || clientAt === best2Client ? [bondLot] : [];
    });
    mocks.bitcoinLocks.getAllLocks.mockReturnValue([pendingSummary.record]);
    mocks.bitcoinLocks.createLockSummaryAt.mockResolvedValueOnce(pendingSummary).mockResolvedValue(mintedSummary);
    mocks.walletsForArgon.readAccountSnapshot
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);

    const financials = useFinancials();

    await vi.waitFor(() => expect(financials.savingsTotalPending).toBe(50n));
    expect(financials.savingsTotalValue).toBe(100n);
    expect(financials.liquidNativeBalances.micronots).toBe(0n);
    expect(financials.financialPositionAggregate.groupSummaries.bonds.currentValue).toBe(20_000_000n);
    expect(financials.bondSummariesByAsset.ARGN.currentValue).toBe(0n);
    expect(financials.bondSummariesByAsset.ARGNOT.currentValue).toBe(20_000_000n);
    expect(financials.financialPositionAggregate.netWorth).toBe(20_000_100n);
    expect(mocks.blockWatch.getApi).toHaveBeenCalledWith(best1);
    expect(mocks.walletHistoryRecovery.hasCompleteCoverage).toHaveBeenCalledWith(finalized.blockNumber);

    mocks.blockWatch.bestBlockHeader = best2;
    mocks.blockWatch.latestHeaders = [finalized, best1, best2];
    const balanceListener = mocks.wallets.on.mock.calls.find(([event]) => event === 'balance-change')?.[1] as
      | (() => void)
      | undefined;
    balanceListener!();

    await vi.waitFor(() => expect(financials.savingsTotalPending).toBe(0n));
    expect(financials.savingsTotalValue).toBe(100n);
    expect(financials.liquidNativeBalances.micronots).toBe(0n);
    expect(financials.financialPositionAggregate.groupSummaries.bonds.currentValue).toBe(20_000_000n);
    expect(financials.financialPositionAggregate.netWorth).toBe(20_000_100n);
    for (const group of ['liquid', 'mining', 'vaulting', 'bonds', 'bitcoin'] as const) {
      expect(financials.financialPositionAggregate.groupSummaries[group].observation).toMatchObject({
        blockNumber: best2.blockNumber,
        blockHash: best2.blockHash,
      });
    }
  });

  it('keeps the coherent book visible while a mining source recovers', async () => {
    const miningPosition = {
      id: 'mining-custody',
      kind: 'mining-balance',
      group: 'mining',
      label: 'Mining balance',
      lifecycle: 'active',
      currentValue: 25n,
      accountId: '5miner',
      asset: 'ARGN',
      amount: 25n,
    } satisfies IFinancialPosition;
    const nextBest = {
      blockNumber: 2,
      blockHash: '0x2',
      blockTime: Date.parse('2026-07-16T12:01:00Z'),
    };
    mocks.config.hasExtensionOperations = true;
    mocks.miningFinancials.loadPositions.mockResolvedValue([miningPosition]);
    const financials = useFinancials();
    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.mining.currentValue).toBe(25n);
    });

    vi.useFakeTimers();
    mocks.miningFinancials.loadPositions.mockRejectedValueOnce(new Error('Mining details are still loading'));
    mocks.blockWatch.bestBlockHeader = nextBest;
    mocks.blockWatch.latestHeaders = [mocks.blockWatch.finalizedBlockHeader, nextBest];
    const balanceListener = mocks.wallets.on.mock.calls.find(([event]) => event === 'balance-change')?.[1] as
      | (() => void)
      | undefined;
    balanceListener!();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.mining.state).toBe('stale');
    });
    expect(financials.financialPositionAggregate.groupSummaries.mining.currentValue).toBe(25n);
    expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.mining.state).toBe('ready');
    });
    expect(financials.financialPositionAggregate.groupSummaries.mining.currentValue).toBe(25n);
    expect(financials.financialPositionAggregate.groupSummaries.mining.observation?.blockHash).toBe(nextBest.blockHash);
    expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
  });

  it('uses deployed product positions rather than the wallet checkpoint for account RTD', async () => {
    const miningPosition = {
      id: 'mining-cohort:1',
      kind: 'mining-cohort',
      group: 'mining',
      label: 'Mining cohort 1',
      lifecycle: 'completed',
      currentValue: 0n,
      investedCost: 100n,
      paidIncome: 30n,
      settledPrincipalValue: 0n,
      startedAt: new Date('2026-07-01T00:00:00Z'),
      endedAt: new Date('2026-07-10T00:00:00Z'),
      cohort: {} as IMiningCohortFinancialRecord,
      recoveredValue: 30n,
      remainingSeatValue: 0n,
      performanceEndingCapital: 130n,
    } satisfies IFinancialPosition;
    mocks.config.hasExtensionOperations = true;
    mocks.miningFinancials.loadPositions.mockResolvedValue([miningPosition]);
    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.mining.state).toBe('ready');
    });
    expect(financials.financialPositionAggregate.accountReturn).toMatchObject({
      availability: 'available',
      percent: 30,
      investmentPositionCount: 1,
    });
  });

  it('does not poll the indexer when imported-account recovery was already initialized', async () => {
    mocks.config.hasExtensionTreasury = true;
    mocks.config.walletAccountsHadPreviousLife = true;
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(false);

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
    await vi.waitFor(() => expect(mocks.needsFinancialHistoryRecovery).toHaveBeenCalled());
    expect(mocks.restoreFinancialHistory).not.toHaveBeenCalled();
  });

  it('requests recovery when live wallet tracking reports a history gap', async () => {
    mocks.config.hasExtensionTreasury = true;

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
    const gapListener = mocks.walletsForArgon.events.on.mock.calls.find(([event]) => event === 'history:gap')?.[1] as
      | ((gap: { afterBlock: number; toBlock: number }) => void)
      | undefined;
    expect(gapListener).toBeDefined();

    gapListener!({ afterBlock: 1, toBlock: 10 });

    await vi.waitFor(() => expect(mocks.restoreFinancialHistory).toHaveBeenCalled());
    expect(mocks.restoreFinancialHistory).toHaveBeenCalledWith(expect.objectContaining({ minimumAsOfBlock: 10 }));
  });

  it('keeps local positions available while recovery is unavailable', async () => {
    mocks.config.hasExtensionTreasury = true;
    mocks.config.walletAccountsHadPreviousLife = true;
    mocks.restoreFinancialHistory.mockRejectedValue(new Error('indexer unavailable'));

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.historyRecovery.state).toBe('error');
    });
    expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
  });
});

function createAccountSnapshot(
  header: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash' | 'blockTime'>,
  availableMicrogons = 0n,
): IArgonAccountSnapshot {
  return {
    accounts: [
      {
        address: '5default',
        wallet: mocks.wallets.defaultArgonWallet as WalletForArgon,
        availableMicrogons,
        reservedMicrogons: 0n,
        availableMicronots: 0n,
        reservedMicronots: 0n,
        microgonHolds: [],
        micronotHolds: [],
      },
    ],
    observation: {
      observedAt: new Date(header.blockTime),
      blockNumber: header.blockNumber,
      blockHash: header.blockHash,
    },
  };
}

function createBitcoinSummary(pendingLiquidity: bigint) {
  const record = {
    uuid: 'bitcoin-lock',
    utxoId: 1,
    status: 'LockedAndIsMinting',
    satoshis: 100_000n,
    liquidityPromised: 50n,
    lockedTargetPrice: 100n,
    ratchets: [
      {
        mintAmount: 50n,
        mintPending: pendingLiquidity,
        lockedTargetPrice: 100n,
        securityFee: 0n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 1,
        oracleBitcoinBlockHeight: 1,
      },
    ],
    createdAt: new Date('2026-07-16T12:00:00Z'),
  };

  return {
    uuid: record.uuid,
    utxoId: record.utxoId,
    status: record.status,
    statusDetails: {
      hasObservedFundingSignal: true,
      showMismatchAccept: false,
      showFundingMismatch: false,
      showReadyForBitcoin: false,
      isFundingSeenInMempoolOnly: false,
    },
    lockProcessingDetails: { progressPct: 100, confirmations: 1, expectedConfirmations: 1 },
    lockProcessingError: '',
    satoshis: record.satoshis,
    valueOfBtc: 100n,
    totalLiquidity: 50n,
    pendingLiquidity,
    receivedLiquidity: 50n - pendingLiquidity,
    valueBeyondLiquidity: 0n,
    startingCapital: 100n,
    endingCapital: 100n,
    ratchetPercent: 0,
    totalReturn: 0,
    securityFees: 0n,
    totalFees: 0n,
    unlockAmount: 100n,
    createdAt: record.createdAt,
    record,
  };
}
