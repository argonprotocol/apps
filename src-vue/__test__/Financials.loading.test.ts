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
      bestBlockHeader: { blockNumber: 1 },
      finalizedBlockHeader: { blockNumber: 1 },
    },
    config: {
      isLoadedPromise: Promise.resolve(),
      hasExtensionTreasury: false,
      hasExtensionOperations: false,
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
      data: { pendingCollectRevenue: 0n },
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
    walletHistoryRecovery: { hasCompleteCoverage: vi.fn(async () => true) },
    wallets: {
      isLoadedPromise: Promise.resolve(),
      defaultArgonWallet: wallet('5default'),
      miningBotWallet: wallet('5miner'),
      operationalWallet: wallet('5operational'),
      ethereumWallet: wallet('0xethereum'),
      baseWallet: wallet('0xbase'),
      externalFinancialPositions: [],
      on: vi.fn(),
    },
    walletsForArgon: {
      events: { on: vi.fn() },
      createFinancialPositions: vi.fn(async () => []),
      readAccountSnapshot: vi.fn(),
    },
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
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: vi.fn() }));
vi.mock('../stores/myMiningSeats.ts', () => ({ getMyMiningSeats: () => mocks.myMiningSeats }));
vi.mock('../stores/vaultingStats.ts', () => ({ useVaultingStats: () => mocks.vaultingStats }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => mocks.config }));
vi.mock('../stores/stableSwaps.ts', () => ({ useStableSwaps: () => mocks.stableSwaps }));
vi.mock('../lib/recovery/index.ts', () => ({
  getEnabledFinancialHistoryDomains: vi.fn(() => []),
  restoreFinancialHistory: vi.fn(),
}));

import { useFinancials } from '../stores/financials.ts';

describe('financials startup failures', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mocks.config.isLoadedPromise = Promise.resolve();
    mocks.config.hasExtensionTreasury = false;
    mocks.config.hasExtensionOperations = false;
    mocks.wallets.isLoadedPromise = Promise.resolve();
    mocks.currency.isLoadedPromise = Promise.resolve();
    mocks.argonBonds.load.mockResolvedValue();
    mocks.bitcoinLocks.load.mockResolvedValue();
    mocks.vaults.load.mockResolvedValue();
    mocks.myVault.load.mockResolvedValue();
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
    {
      name: 'an enabled domain',
      message: 'bond loading failed',
      fail: () => {
        mocks.config.hasExtensionTreasury = true;
        mocks.argonBonds.load.mockRejectedValue(new Error('bond loading failed'));
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
});
