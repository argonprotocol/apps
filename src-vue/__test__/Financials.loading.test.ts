import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';

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

  return {
    argonBonds: {
      data: { bondLots: [], bondHistory: [] },
      load: vi.fn<() => Promise<void>>(),
      createFinancialPositions: vi.fn(() => []),
    },
    bitcoinLocks: {
      data: { locksByUtxoId: {}, pendingLocks: [], latestArgonBlock: undefined },
      recovery: {},
      load: vi.fn<() => Promise<void>>(),
      getAllLocks: vi.fn(() => []),
      isInactiveForVaultDisplay: vi.fn(() => false),
      refreshLockSummary: vi.fn(),
    },
    blockWatch: {
      bestBlockHeader: { blockNumber: 1, blockHash: '0x1', blockTime: Date.parse('2026-07-16T12:00:00Z') },
      finalizedBlockHeader: { blockNumber: 1, blockHash: '0x1', blockTime: Date.parse('2026-07-16T12:00:00Z') },
      getApi: vi.fn(async () => ({})),
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
    myVault: {
      createdVault: undefined,
      data: {
        pendingCollectRevenue: 0n,
        argonotCommitment: {
          committedMicronots: 0n,
          encumberedMicronots: 0n,
        },
      },
      history: {},
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
    db: {
      financialCacheTable: {
        get: vi.fn(async () => undefined),
        upsert: vi.fn(async () => undefined),
      },
      walletTransfersTable: {
        fetchExternalFlows: vi.fn(async () => []),
      },
    },
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
          fetchArgonotCustody: vi.fn(async () => []),
        },
      }),
      createFinancialPositions: vi.fn(async () => []),
      defaultArgonWallet: { address: '5default' },
      miningBotWallet: { address: '5miner' },
      operationalWallet: { address: '5operational' },
      legacyMiningHoldAddress: '',
      ownedAddresses: ['5default', '5miner', '5operational'],
      readAccountSnapshot: vi.fn(async () => ({
        accounts: [],
        observation: {
          observedAt: new Date('2026-07-16T12:00:00Z'),
          blockNumber: 1,
          blockHash: '0x1',
        },
      })),
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
vi.mock('../stores/vaultingStats.ts', () => ({ useVaultingStats: () => mocks.vaultingStats }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => mocks.config }));
vi.mock('../stores/stableSwaps.ts', () => ({ useStableSwaps: () => mocks.stableSwaps }));
vi.mock('../lib/recovery/index.ts', () => ({
  getEnabledFinancialHistoryDomains: vi.fn(() => []),
  needsFinancialHistoryRecovery: mocks.needsFinancialHistoryRecovery,
  restoreFinancialHistory: mocks.restoreFinancialHistory,
}));

import { useFinancials } from '../stores/financials.ts';

describe('financials startup failures', () => {
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
    mocks.argonBonds.load.mockResolvedValue();
    mocks.bitcoinLocks.load.mockResolvedValue();
    mocks.vaults.load.mockResolvedValue();
    mocks.myVault.load.mockResolvedValue();
    mocks.stableSwaps.load.mockResolvedValue();
    mocks.stableSwaps.load.mockClear();
    mocks.stableSwaps.refreshWalletSnapshot.mockResolvedValue();
    mocks.restoreFinancialHistory.mockResolvedValue({ asOfBlock: 1, importedBlockCount: 0 });
    mocks.restoreFinancialHistory.mockClear();
    mocks.needsFinancialHistoryRecovery.mockResolvedValue(true);
    mocks.needsFinancialHistoryRecovery.mockClear();
    mocks.walletHistoryRecovery.hasCompleteCoverage.mockClear();
    mocks.db.financialCacheTable.get.mockResolvedValue(undefined);
    mocks.db.financialCacheTable.get.mockClear();
    mocks.db.financialCacheTable.upsert.mockResolvedValue(undefined);
    mocks.db.financialCacheTable.upsert.mockClear();
    mocks.db.walletTransfersTable.fetchExternalFlows.mockClear();
    mocks.walletsForArgon.events.on.mockClear();
  });

  afterEach(() => {
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

  it('keeps liquid balances available when an enabled domain fails to load', async () => {
    mocks.config.hasExtensionTreasury = true;
    mocks.argonBonds.load.mockRejectedValue(new Error('bond loading failed'));

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
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

  it('baselines RTD while wallet history catches up for an account created in this app session', async () => {
    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
    });
    expect(mocks.walletHistoryRecovery.hasCompleteCoverage).toHaveBeenCalledWith(1);
    await vi.waitFor(() => {
      expect(mocks.db.financialCacheTable.upsert).toHaveBeenCalledWith(
        'AccountReturn',
        '5default,5miner,5operational',
        expect.objectContaining({
          startingBlock: 1,
          startingValue: 0n,
          asOfBlock: 1,
          basisPoints: 0n,
          isProvisional: true,
        }),
      );
    });
    expect(financials.accountReturnSyncState).toBe('updating');
    expect(mocks.restoreFinancialHistory).not.toHaveBeenCalled();
  });

  it('keeps loading live positions when the saved RTD cannot be read', async () => {
    mocks.db.financialCacheTable.get.mockRejectedValueOnce(new Error('cache unavailable'));

    const financials = useFinancials();

    await vi.waitFor(() => {
      expect(financials.financialPositionAggregate.groupSummaries.liquid.state).toBe('ready');
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
