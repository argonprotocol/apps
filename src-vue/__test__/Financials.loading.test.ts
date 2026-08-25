import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { type ArgonQueryClient, BondLot, type IBlockHeaderInfo, type Vault } from '@argonprotocol/apps-core';
import {
  type FrameSupportTokensMiscIdAmountRuntimeHoldReason,
  getOfflineRegistry,
  type PalletTreasuryBondLot,
} from '@argonprotocol/mainchain';
import { toPlain, type TreasuryBondLotByIdResult } from '@argonprotocol/runtime-client';
import type { IFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import type { IArgonAccountBalance, IArgonAccountSnapshot } from '../lib/WalletsForArgon.ts';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import type { IMiningCohortFinancialRecord } from '../interfaces/db/ICohortFrameRecord.ts';
import type { IVaultCapitalHistoryRecord } from '../lib/db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../lib/db/VaultRevenueEventsTable.ts';
import type { IWallet } from '../lib/Wallet.ts';

type FinancialHistoryRestoreArgs = Parameters<typeof import('../lib/recovery/index.ts').restoreFinancialHistory>[0];

const mocks = vi.hoisted(() => {
  const wallet = (address: string, type: IWallet['type']) => ({
    type,
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
      createLockSummary: vi.fn((_lock: object) => createBitcoinSummary(0n)),
      createLockSummaryAt: vi.fn(async (_lock: object, _api: object) => createBitcoinSummary(0n)),
      isLockedStatus: vi.fn(() => true),
      isFinishedStatus: vi.fn(() => false),
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
    mainchainClients: {},
    config: {
      isLoaded: true,
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
      fetchMicrogonsInCirculation: vi.fn(async () => 0n),
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
      createdVault: undefined as Vault | undefined,
      vaults: { operatorNamesByVaultId: {} },
      data: {
        pendingCollectRevenue: 0n,
        argonotCommitment: {
          committedMicronots: 0n,
          encumberedMicronots: 0n,
        },
      },
      history: {
        loadPositionHistory: vi.fn<
          () => Promise<{ capital: IVaultCapitalHistoryRecord[]; revenue: IVaultRevenueEventsRecord[] }>
        >(async () => ({ capital: [], revenue: [] })),
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
      defaultArgonWallet: wallet('5default', 'argon'),
      miningBotWallet: wallet('5miner', 'miningBot'),
      operationalWallet: wallet('5operational', 'operational'),
      ethereumWallet: {
        ...wallet('0xethereum', 'ethereum'),
        balanceUpdatedAt: new Date('2026-07-17T12:00:00Z'),
      },
      ethereumWallets: {
        persistedWallets: [
          {
            address: '0xethereum',
            data: {
              ...wallet('0xethereum', 'ethereum'),
              balanceUpdatedAt: new Date('2026-07-17T12:00:00Z'),
            },
          },
        ],
        length: 1,
      },
      ethereumFinancialPositions: [] as IFinancialPosition[],
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
    restoreFinancialHistory: vi.fn(async (_args?: FinancialHistoryRestoreArgs) => ({
      asOfBlock: 1,
      importedBlockCount: 0,
    })),
    needsFinancialHistoryRecovery: vi.fn(async () => true),
    getEnabledFinancialHistoryDomains: vi.fn(() => [] as ('bitcoin' | 'bonds' | 'vaulting')[]),
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
vi.mock('../stores/mainchain.ts', () => ({
  getBlockWatch: () => mocks.blockWatch,
  getMainchainClients: () => mocks.mainchainClients,
}));
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
  getEnabledFinancialHistoryDomains: mocks.getEnabledFinancialHistoryDomains,
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
    mocks.config.isLoaded = true;
    mocks.config.hasExtensionTreasury = false;
    mocks.config.hasExtensionOperations = false;
    mocks.config.hasActivatedStableSwaps = false;
    mocks.config.walletAccountsHadPreviousLife = false;
    mocks.wallets.isLoadedPromise = Promise.resolve();
    mocks.currency.isLoadedPromise = Promise.resolve();
    mocks.currency.microgonsPer.ARGNOT = 0n;
    mocks.currency.fetchMicrogonsInCirculation.mockResolvedValue(0n);
    mocks.currency.fetchMicrogonsInCirculation.mockClear();
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
    mocks.bitcoinLocks.createLockSummary.mockImplementation(() => createBitcoinSummary(0n));
    mocks.bitcoinLocks.createLockSummary.mockClear();
    mocks.bitcoinLocks.createLockSummaryAt.mockImplementation(async () => createBitcoinSummary(0n));
    mocks.bitcoinLocks.createLockSummaryAt.mockClear();
    mocks.bitcoinLocks.isLockedStatus.mockReturnValue(true);
    mocks.bitcoinLocks.isFinishedStatus.mockReturnValue(false);
    mocks.bitcoinLocks.isReleaseStatus.mockReturnValue(false);
    mocks.bitcoinLocks.isInactiveForVaultDisplay.mockReturnValue(false);
    mocks.vaults.load.mockResolvedValue();
    mocks.vaultingStats.argonBurnCapacity = 0;
    mocks.vaultingStats.microgonValueInVaults = 0n;
    mocks.myVault.load.mockResolvedValue();
    mocks.myVault.createdVault = undefined;
    mocks.miningFinancials.loadPositions.mockResolvedValue([]);
    mocks.miningFinancials.loadPositions.mockClear();
    mocks.stableSwaps.load.mockResolvedValue();
    mocks.stableSwaps.load.mockClear();
    mocks.stableSwaps.refreshWalletSnapshot.mockResolvedValue();
    mocks.restoreFinancialHistory.mockResolvedValue({ asOfBlock: 1, importedBlockCount: 0 });
    mocks.restoreFinancialHistory.mockClear();
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(false);
    mocks.needsFinancialHistoryRecovery.mockClear();
    mocks.getEnabledFinancialHistoryDomains.mockReturnValue([]);
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
    mocks.wallets.ethereumWallets = {
      persistedWallets: [
        {
          address: '0xethereum',
          data: {
            ...mocks.wallets.ethereumWallet,
            balanceUpdatedAt: new Date('2026-07-17T12:00:00Z'),
          },
        },
      ],
      length: 1,
    };
    mocks.wallets.ethereumFinancialPositions = [];
    mocks.myVault.history.loadPositionHistory.mockResolvedValue({ capital: [], revenue: [] });
    mocks.myVault.history.loadPositionHistory.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    disposePinia(pinia);
    vi.restoreAllMocks();
  });

  it('includes every Ethereum wallet in the financial aggregate', async () => {
    const firstWallet = {
      ...mocks.wallets.ethereumWallet,
      address: '0xethereum1',
      totalMicrogons: 0n,
      totalMicronots: 0n,
      balanceUpdatedAt: new Date('2026-07-17T12:00:00Z'),
    };
    const secondWallet = {
      ...mocks.wallets.ethereumWallet,
      address: '0xethereum2',
      totalMicrogons: 0n,
      totalMicronots: 0n,
      balanceUpdatedAt: new Date('2026-07-17T12:00:00Z'),
    };
    mocks.wallets.ethereumWallets = {
      persistedWallets: [
        { address: firstWallet.address, data: firstWallet },
        { address: secondWallet.address, data: secondWallet },
      ],
      length: 2,
    };
    mocks.wallets.ethereumFinancialPositions = [
      {
        id: '0xethereum1:ethereum:ARGN',
        kind: 'ethereum-wallet-balance',
        group: 'ethereum',
        label: 'Ethereum ARGN',
        lifecycle: 'available',
        currentValue: 100n,
        wallet: firstWallet,
        asset: 'ethereum:ARGN',
        nativeAmount: 100n,
      },
      {
        id: '0xethereum2:ethereum:ARGN',
        kind: 'ethereum-wallet-balance',
        group: 'ethereum',
        label: 'Ethereum ARGN',
        lifecycle: 'available',
        currentValue: 200n,
        wallet: secondWallet,
        asset: 'ethereum:ARGN',
        nativeAmount: 200n,
      },
    ];

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.ethereum.currentValue).toBe(300n);
    });
    expect(financials.financialPositionAggregate.netWorth).toBe(300n);
  });

  it('calculates savings restabilization power from circulating ARGN without Treasury access', async () => {
    mocks.currency.fetchMicrogonsInCirculation.mockResolvedValue(10_000_000n);
    mocks.vaultingStats.argonBurnCapacity = 25;

    const financials = useFinancials();

    await vi.waitFor(() => expect(financials.savingsIsLoaded).toBe(true));
    expect(financials.savingsRestabilizationPower).toBe(2.5);
    expect(mocks.currency.fetchMicrogonsInCirculation).toHaveBeenCalledOnce();
    expect(mocks.argonBonds.load).not.toHaveBeenCalled();
    expect(mocks.bitcoinLocks.load).not.toHaveBeenCalled();
    expect(mocks.vaults.load).not.toHaveBeenCalled();
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
    const runtimeLot = toPlain(
      registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
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
      }),
    ) as NonNullable<TreasuryBondLotByIdResult>;
    const treasuryHold = toPlain(
      registry.createType<FrameSupportTokensMiscIdAmountRuntimeHoldReason>(
        'FrameSupportTokensMiscIdAmountRuntimeHoldReason',
        {
          id: { Treasury: 'ContributedToTreasury' },
          amount: 20_000_000n,
        },
      ),
    ) as IArgonAccountBalance['micronotHolds'][number];
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
    const bondLot = BondLot.fromRuntime(1, runtimeLot, runtimeLot.owner);
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

  it('keeps enabled domains pending until imported-account coverage is confirmed', async () => {
    mocks.config.hasExtensionTreasury = true;
    mocks.config.walletAccountsHadPreviousLife = true;
    mocks.getEnabledFinancialHistoryDomains.mockReturnValue(['bitcoin', 'bonds', 'vaulting']);
    let finishCoverageCheck: ((needsRecovery: boolean) => void) | undefined;
    mocks.needsFinancialHistoryRecovery.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishCoverageCheck = resolve;
        }),
    );

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
    await vi.waitFor(() => expect(mocks.needsFinancialHistoryRecovery).toHaveBeenCalled());
    expect(financials.historyRecoveryByDomain.bonds.state).toBe('checking');
    expect(financials.historyRecoveryByDomain.bitcoin.state).toBe('checking');

    finishCoverageCheck?.(false);
    await vi.waitFor(() => expect(financials.historyRecoveryByDomain.bonds.state).toBe('ready'));
    expect(financials.historyRecovery.state).toBe('ready');
    expect(mocks.restoreFinancialHistory).not.toHaveBeenCalled();
    expect(mocks.walletsForArgon.readAccountSnapshot).toHaveBeenCalledTimes(2);
  });

  it('resumes and surfaces pending domain recovery without imported-account history', async () => {
    mocks.config.hasExtensionTreasury = true;
    mocks.getEnabledFinancialHistoryDomains.mockReturnValue(['bitcoin', 'bonds']);
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(true);
    mocks.restoreFinancialHistory.mockRejectedValue(new Error('history unavailable'));

    const financials = useFinancials();

    await vi.waitFor(() => expect(financials.historyRecovery.state).toBe('error'));
    expect(financials.historyRecoveryByDomain.bitcoin.state).toBe('error');
    expect(financials.historyRecoveryByDomain.bonds.state).toBe('error');
    expect(mocks.needsFinancialHistoryRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bitcoinLockRecovery: mocks.bitcoinLocks.recovery,
        recoverMissingCheckpointsFor: [],
      }),
    );
  });

  it('exposes persisted Bitcoin rows and settled performance before the complete financial snapshot is ready', () => {
    const cachedSummary = createBitcoinSummary(0n);
    const persistedSummary = {
      ...cachedSummary,
      status: 'Released',
      receivedLiquidity: 30n,
      historicalTotalFees: 20n,
      record: {
        ...cachedSummary.record,
        status: 'Released',
        removalReason: 'released',
        removalBlockTime: new Date('2026-07-17T12:00:00Z'),
        releaseRedemptionMicrogons: 40n,
        releaseArgonTxFeeMicrogons: 3n,
        releaseCompensationMicrogons: 0n,
        btcPriceAtRemovalMicrogons: 1_200_000n,
        isHistoryRecoveryPending: false,
        fundingUtxoRecord: {
          releaseBitcoinNetworkFee: 1_000n,
        },
      },
    };
    mocks.config.hasExtensionTreasury = true;
    mocks.wallets.isLoadedPromise = new Promise(() => undefined);
    mocks.bitcoinLocks.getAllLocks.mockReturnValue([persistedSummary.record]);
    mocks.bitcoinLocks.createLockSummary.mockReturnValue(persistedSummary);

    const financials = useFinancials();

    expect(financials.bitcoinLockDisplayRecords).toEqual([persistedSummary]);
    expect(financials.bitcoinLockPerformanceByUuid[persistedSummary.uuid]).toEqual({
      profit: -30n,
      percent: -30,
    });
    expect(financials.savingsIsLoaded).toBe(false);
  });

  it('uses the live Bitcoin record after loading its financial snapshot', async () => {
    const snapshotSummary = createBitcoinSummary(0n);
    snapshotSummary.record = {
      ...snapshotSummary.record,
      isHistoryRecoveryPending: true,
    };
    const liveRecord = {
      ...snapshotSummary.record,
      isHistoryRecoveryPending: false,
    };
    mocks.config.hasExtensionTreasury = true;
    mocks.bitcoinLocks.getAllLocks.mockReturnValue([liveRecord]);
    mocks.bitcoinLocks.createLockSummaryAt.mockResolvedValue(snapshotSummary);

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
    expect(financials.bitcoinLockDisplayRecords[0]?.record).toBe(liveRecord);
  });

  it('archives funded Bitcoin history without presenting abandoned lock requests as transactions', () => {
    const baseSummary = createBitcoinSummary(0n);
    const abandonedSummary = {
      ...baseSummary,
      uuid: 'abandoned-lock-request',
      status: 'LockExpiredWaitingForFundingAcknowledged',
      record: {
        ...baseSummary.record,
        uuid: 'abandoned-lock-request',
        status: 'LockExpiredWaitingForFundingAcknowledged',
      },
    };
    const releasedSummary = {
      ...baseSummary,
      uuid: 'released-lock',
      status: 'Released',
      record: {
        ...baseSummary.record,
        uuid: 'released-lock',
        status: 'Released',
        removalReason: 'released',
      },
    };
    mocks.bitcoinLocks.getAllLocks.mockReturnValue([abandonedSummary.record, releasedSummary.record]);
    mocks.bitcoinLocks.createLockSummary.mockImplementation(lock => {
      return lock === abandonedSummary.record ? abandonedSummary : releasedSummary;
    });
    mocks.bitcoinLocks.isInactiveForVaultDisplay.mockReturnValue(true);

    const financials = useFinancials();

    expect(financials.liquidInvisibleRecords).toEqual([releasedSummary]);
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

    vi.useFakeTimers();
    gapListener!({ afterBlock: 1, toBlock: 10 });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.restoreFinancialHistory).toHaveBeenCalled();
    expect(mocks.restoreFinancialHistory).toHaveBeenCalledWith(expect.objectContaining({ minimumAsOfBlock: 10 }));
  });

  it('publishes successful domain history when Bitcoin recovery fails', async () => {
    const registry = getOfflineRegistry();
    const runtimeLot = toPlain(
      registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
        owner: `0x${'11'.repeat(32)}`,
        program: { Vault: { vaultId: 4, sharingPercent: 0, bonusPercent: 0 } },
        bonds: 10,
        createdFrameId: 1,
        participatedFrames: 0,
        lastFrameEarningsFrameId: 1,
        lastFrameEarnings: 0,
        cumulativeEarnings: 1_000_000,
        releaseFrameId: null,
        releaseReason: null,
      }),
    ) as NonNullable<TreasuryBondLotByIdResult>;
    const treasuryHold = toPlain(
      registry.createType<FrameSupportTokensMiscIdAmountRuntimeHoldReason>(
        'FrameSupportTokensMiscIdAmountRuntimeHoldReason',
        {
          id: { Treasury: 'ContributedToTreasury' },
          amount: 10_000_000n,
        },
      ),
    ) as IArgonAccountBalance['microgonHolds'][number];
    const vaultHold = toPlain(
      registry.createType<FrameSupportTokensMiscIdAmountRuntimeHoldReason>(
        'FrameSupportTokensMiscIdAmountRuntimeHoldReason',
        {
          id: { Vaults: 'EnterVault' },
          amount: 8_000_000n,
        },
      ),
    ) as IArgonAccountBalance['microgonHolds'][number];
    const snapshot = createAccountSnapshot(mocks.blockWatch.bestBlockHeader);
    snapshot.accounts[0].reservedMicrogons = 18_000_000n;
    snapshot.accounts[0].microgonHolds = [treasuryHold, vaultHold];

    mocks.config.hasExtensionTreasury = true;
    mocks.config.hasExtensionOperations = true;
    mocks.config.walletAccountsHadPreviousLife = true;
    mocks.getEnabledFinancialHistoryDomains.mockReturnValue(['bitcoin', 'bonds', 'vaulting']);
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(true);
    mocks.argonBonds.data.bondLots = [BondLot.fromRuntime(1, runtimeLot, '5default')];
    mocks.myVault.createdVault = {
      vaultId: 10,
      securitization: 8_000_000n,
      isClosed: false,
      openedDate: new Date('2026-07-01T00:00:00Z'),
    } as Vault;
    mocks.myVault.history.loadPositionHistory.mockResolvedValue({
      capital: [
        {
          id: 1,
          walletAddress: '5default',
          vaultId: 10,
          eventType: 'created',
          securitization: 8_000_000n,
          blockNumber: 1,
          blockHash: '0x1',
          blockTime: new Date('2026-07-01T00:00:00Z'),
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
      revenue: [],
    });
    mocks.walletsForArgon.readAccountSnapshot.mockResolvedValue(snapshot);
    mocks.restoreFinancialHistory.mockImplementation(async (args?: FinancialHistoryRestoreArgs) => {
      args?.onDomainComplete?.({ domain: 'bonds', asOfBlock: 1 });
      args?.onDomainComplete?.({ domain: 'vaulting', asOfBlock: 1 });
      args?.onDomainComplete?.({ domain: 'bitcoin', asOfBlock: 0, error: 'indexer unavailable' });
      throw new Error('indexer unavailable');
    });

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.historyRecovery.state).toBe('error');
    });
    expect(financials.historyRecoveryByDomain.bonds.state).toBe('ready');
    expect(financials.historyRecoveryByDomain.vaulting.state).toBe('ready');
    expect(financials.historyRecoveryByDomain.bitcoin.state).toBe('error');
    expect(financials.financialPositionAggregate.groupSummaries.bonds.returnSummary).toMatchObject({
      availability: 'available',
      investedCost: 10_000_000n,
    });
    expect(financials.financialPositionAggregate.groupSummaries.vaulting.returnSummary).toMatchObject({
      availability: 'available',
      investedCost: 8_000_000n,
    });
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
        wallet: mocks.wallets.defaultArgonWallet as unknown as WalletForArgon,
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
    isHistoryRecoveryPending: false,
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
