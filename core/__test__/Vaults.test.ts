import BigNumber from 'bignumber.js';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  getBundledMetadata,
  runtimeClient,
  toPlain,
  type VaultsVaultsByIdResultSpec159Variant15,
} from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { RuntimeSystemEventRecord } from '../src/index.ts';
import { nextTick, reactive, shallowReactive, watchEffect } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '../src/Deferred.ts';
import { calculateRestabilizationLeverage } from '../src/GlobalVaultingStats.ts';
import type { IAllVaultStats, IVaultFrameStats, IVaultStats } from '../src/interfaces/IVaultStats.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { VAULT_STATS_FORMAT_VERSION, Vaults } from '../src/Vaults.ts';
import mainnetVaultRevenueHistory from '../src/data/vaultRevenue.mainnet.json' with { type: 'json' };

beforeEach(() => {
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.clearRuntimeOverride('mainnet');
});

const currentVault = {
  operatorAccountId: '5SyntheticOperator',
  delegateAccountId: null,
  securitization: 2_000_000_000n,
  securitizationTarget: 2_000_000_000n,
  securitizationLocked: 0n,
  flexibleSecuritizationLocked: 0n,
  reservedSecuritizationSpace: 0n,
  securitizationPendingActivation: 0n,
  securitizedSatoshis: 0n,
  totalSatoshis: 0n,
  ratioAdjustedSatoshis: 0n,
  flexibleRatioAdjustedSatoshis: 0n,
  securitizationReleaseSchedule: {},
  securitizationRatio: new BigNumber(1),
  isClosed: false,
  terms: { bitcoinAnnualPercentRate: new BigNumber(0), bitcoinBaseFee: 0n, treasuryProfitSharing: new BigNumber(0) },
  pendingTerms: null,
  openedTick: 1,
  operationalMinimumReleaseTick: null,
} satisfies NonNullable<VaultsVaultsByIdResultSpec159Variant15>;

it('publishes current vaults before statistics and preserves them through failure and retry', async () => {
  const statsReady = createDeferred();
  const entries = vi.fn().mockRejectedValueOnce(new Error('offline'));
  const client = {
    consts: {
      vaults: {},
      operationalAccounts: { operationalMinimumVaultSecuritization: 100_000_000n },
    },
    query: {
      vaults: { vaultsById: { entries } },
      operationalAccounts: {
        operationalAccountBySubAccount: { entries: async () => [] },
        operationalAccounts: { entries: async () => [] },
      },
    },
  };
  const vaults = new Vaults(
    'dev-docker',
    {} as any,
    { load: () => statsReady.promise } as any,
    { get: async () => client } as any,
  );
  vaults.currentState = reactive(vaults.currentState);
  vaults.vaultsById = shallowReactive(vaults.vaultsById);
  let visible: string | bigint = 'loading';
  const stop = watchEffect(() => {
    visible = vaults.currentState.isLoaded
      ? (vaults.vaultsById[7]?.availableBitcoinSpace() ?? 'empty')
      : vaults.currentState.error || 'loading';
  });
  try {
    await expect(vaults.loadCurrentState()).rejects.toThrow('offline');
    await nextTick();
    expect(visible).toBe('offline');
    entries.mockResolvedValue([[{ args: [7] }, currentVault]]);
    const loading = vaults.load();
    const failedStats = expect(loading).rejects.toThrow('statistics unavailable');
    await vi.waitFor(() => expect(visible).toBe(2_000_000_000n));
    expect(vaults.stats).toBeUndefined();
    statsReady.reject(new Error('statistics unavailable'));
    await failedStats;
    expect(visible).toBe(2_000_000_000n);
    entries.mockRejectedValueOnce(new Error('refresh unavailable'));
    await expect(vaults.loadCurrentState(true)).rejects.toThrow('refresh unavailable');
    expect(vaults.currentState.error).toBe('refresh unavailable');
    expect(visible).toBe(2_000_000_000n);
    entries.mockResolvedValue([[{ args: [7] }, { ...currentVault, securitization: 3_000_000_000n }]]);
    await vaults.loadCurrentState(true);
    await nextTick();
    expect(visible).toBe(3_000_000_000n);
    expect(vaults.currentState.error).toBe('');
    entries.mockResolvedValue([]);
    await vaults.loadCurrentState(true);
    await nextTick();
    expect(visible).toBe('empty');
  } finally {
    stop();
  }
});

it('times out current-state loading and ignores a late response after a successful retry', async () => {
  vi.useFakeTimers();
  const delayed = createDeferred<unknown[]>();
  const entries = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue([]);
  const vaults = new Vaults(
    'dev-docker',
    {} as any,
    {} as any,
    {
      get: async () => ({ query: { vaults: { vaultsById: { entries } } } }),
    } as any,
  );
  try {
    const failed = expect(vaults.loadCurrentState()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(vaults.currentState.isLoading).toBe(false);
    await vaults.loadCurrentState(true);
    delayed.resolve([[{ args: [7] }, currentVault]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(vaults.currentState).toMatchObject({ isLoaded: true, isLoading: false, error: '' });
    expect(vaults.vaultsById).toEqual({});
  } finally {
    vi.useRealTimers();
  }
});

describe('Vaults load retry', () => {
  it('retries after an initial bootstrap failure', async () => {
    const miningFrames = {
      load: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined),
    };
    const client = {
      consts: { vaults: {} },
      query: {
        vaults: {
          vaultsById: {
            entries: vi.fn().mockResolvedValue([]),
          },
        },
      },
    };
    const mainchainClients = {
      get: vi.fn().mockResolvedValue(client),
    };
    const vaults = new Vaults('dev-docker', {} as any, miningFrames as any, mainchainClients as any);

    await expect(vaults.load()).rejects.toThrow('offline');
    await expect(vaults.load()).resolves.toBeUndefined();

    expect(miningFrames.load).toHaveBeenCalledTimes(2);
    expect(client.query.vaults.vaultsById.entries).toHaveBeenCalledOnce();
    expect(vaults.stats?.synchedToFrame).toBe(0);
  });

  it('migrates a v1 local cache and preserves locally collected vault history', async () => {
    const miningFrames = {
      load: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      consts: { vaults: {} },
      query: {
        vaults: {
          vaultsById: { entries: vi.fn().mockResolvedValue([]) },
        },
      },
    };
    const mainchainClients = { get: vi.fn().mockResolvedValue(client) };
    const cachedStats = createStats([createFrame({ frameId: 20 })]);
    cachedStats.formatVersion = 1;
    const vaults = new CachedVaults(cachedStats, miningFrames, mainchainClients);

    await vaults.load();

    expect(vaults.stats).not.toBe(cachedStats);
    expect(vaults.stats?.formatVersion).toBe(VAULT_STATS_FORMAT_VERSION);
    expect(vaults.stats?.vaultsById).toBe(cachedStats.vaultsById);
    expect(vaults.stats?.argonotStakingByFrame).toEqual([]);
  });

  it('restores bundled staking history through its serializer instead of dropping it', async () => {
    vi.useFakeTimers();
    try {
      const frames = {
        load: async () => undefined,
        currentFrameId: mainnetVaultRevenueHistory.synchedToFrame + 1,
      };
      const clients = { get: async () => ({ query: { vaults: { vaultsById: { entries: async () => [] } } } }) };
      const vaults = new Vaults('mainnet', {} as any, frames as any, clients as any);
      await vaults.load();

      expect(typeof vaults.stats?.argonotStakingByFrame[0]?.poolDistributed).toBe('bigint');
      expect(vaults.calculateArgonotStakingApr()).toBeGreaterThan(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('finishes loading before operator profile names are available', async () => {
    const operatorAccountId = `0x${'02'.repeat(32)}`;
    const operationalAccountId = `0x${'01'.repeat(32)}`;
    const profileEntries = createDeferred<any[]>();
    const client = {
      consts: {
        vaults: {},
        operationalAccounts: { operationalMinimumVaultSecuritization: 100_000_000n },
      },
      query: {
        vaults: {
          vaultsById: { entries: vi.fn().mockResolvedValue([]) },
        },
        operationalAccounts: {
          operationalAccountBySubAccount: {
            entries: vi.fn().mockResolvedValue([[{ args: [operatorAccountId] }, operationalAccountId]]),
          },
          operationalAccounts: { entries: vi.fn(() => profileEntries.promise) },
        },
      },
    };
    const miningFrames = { load: vi.fn().mockResolvedValue(undefined) };
    const mainchainClients = { get: vi.fn().mockResolvedValue(client) };
    const vaults = new Vaults('mainnet', {} as any, miningFrames as any, mainchainClients as any);
    vaults.stats = createStats([]);
    client.query.vaults.vaultsById.entries.mockResolvedValue([[{ args: [1] }, { ...currentVault, operatorAccountId }]]);

    await expect(vaults.load()).resolves.toBeUndefined();
    expect(vaults.operatorNamesByVaultId[1]).toBeUndefined();

    profileEntries.resolve([[{ args: [operationalAccountId] }, { name: new TextEncoder().encode('Atlas') }]]);
    await vi.waitFor(() => expect(vaults.operatorNamesByVaultId[1]).toBe('Atlas'));
  });
});

describe('Vault revenue sync', () => {
  it('excludes historical flexible bond income while retaining direct vault income after the upgrade', async () => {
    const deployedRegistry = new TypeRegistry();
    const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
    deployedRegistry.setMetadata(new Metadata(deployedRegistry, metadata));
    const registry = getOfflineRegistry();
    const historicalRevenue = deployedRegistry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
      {
        frameId: 20,
        bitcoinLockFeeRevenue: 100_000_000n,
        bitcoinLockFeeCouponValueUsed: 40_000_000n,
        treasuryTotalEarnings: 101_000_001n,
        treasuryVaultEarnings: 43_666_666n,
        treasuryExternalCapital: 50_000_000n,
        treasuryVaultCapital: 50_000_000n,
        securitization: 1_000_000_000n,
      },
    ]);
    const currentRevenue = registry.createType('Vec<PalletVaultsVaultFrameRevenue>', [
      {
        frameId: 21,
        treasuryTotalEarnings: 70_000_000n,
        treasuryVaultEarnings: 70_000_000n,
        treasuryExternalCapital: 100_000_000n,
        securitization: 1_000_000_000n,
      },
    ]);
    const capital = deployedRegistry.createType('PalletTreasuryFrameVaultCapital', {
      frameId: 20,
      vaults: {
        1: {
          eligibleBonds: 100,
          flexibleBondsEligible: 50,
          // Capacity is 150 bonds: eligible capital alone would incorrectly imply a 50% flexible share.
          flexibleProrata: 333_333_333_333_333_333n,
        },
      },
    });
    const miningFrames = createRevenueMiningFrames([22, 21], frameId => ({
      specVersion: frameId === 22 ? 160 : 159,
      api: {
        query: {
          treasury: {},
          vaults: {
            revenuePerFrameByVault: {
              entries: async () => [[{ args: [1] }, toPlain(frameId === 22 ? currentRevenue : historicalRevenue)]],
            },
          },
        },
      },
    }));
    Object.assign(miningFrames.blockWatch, {
      getHeader: async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` }),
      getApi: async () => ({ query: { treasury: { currentFrameVaultCapital: async () => toPlain(capital) } } }),
    });
    const clients = { get: async () => ({ query: { vaults: { vaultsById: { entries: async () => [] } } } }) };
    const vaults = new Vaults('mainnet', {} as any, miningFrames as any, clients as any);
    vaults.stats = createStats([]);
    vaults.stats.revenueBackfill = { nextFrame: 22, throughFrame: 21 };
    await vaults.updateRevenue();

    // Each frame earned 70 ARGN on 1,000 ARGN securitization; the 33.666666 flexible income belongs to bonds.
    expect(vaults.calculateApr()).toBeCloseTo(2_555);
    expect(vaults.calculateVaultApr(1)).toBeCloseTo(2_555);
    expect(vaults.calculateApy()).toBeCloseTo((1.07 ** 365 - 1) * 100);
    await vaults.updateVaultRevenue(1, toPlain(historicalRevenue) as any);
    expect(vaults.calculateApr()).toBeCloseTo(2_555);
  });

  it('uses completed-frame capital and opening prices, preserving returns when a payout snapshot needs retry', async () => {
    const registry = getOfflineRegistry();
    const events: RuntimeSystemEventRecord[] = [
      {
        phase: { type: 'Initialization' },
        topics: [],
        event: {
          section: 'treasury',
          method: 'FrameEarningsDistributed',
          data: {
            frameId: 20,
            argonBondPoolDistributed: 1_000_000n,
            bidPoolDistributed: 10_000_000n,
            vaultPoolDistributed: 8_000_000n,
            stakePoolDistributed: 1_000_000n,
            treasuryReserves: 0n,
            burned: 0n,
            participatingVaults: 1,
          },
        },
      },
    ];
    const api = {
      query: {
        system: { events: async () => events },
        treasury: {
          currentFrameArgonotBondParticipants: async () => ({ frameId: 21, totalBonds: 10_000 }),
          currentFrameVaultCapital: async () => ({ frameId: 21, totalActiveBonds: 10_000n }),
        },
        vaults: { revenuePerFrameByVault: { entries: async () => [] } },
      },
    };
    let capitalFrame = 20;
    let participantsFrame = 20;
    const parentApi = runtimeClient({
      query: {
        treasury: {
          currentFrameArgonotBondParticipants: async () =>
            registry.createType('Option<PalletTreasuryFrameArgonotBondParticipants>', {
              frameId: participantsFrame,
              totalBonds: 100,
            }),
          currentFrameVaultCapital: async () =>
            registry.createType('Option<PalletTreasuryFrameVaultCapital>', {
              frameId: capitalFrame,
              totalActiveBonds: 100n,
              targetSecuritization: 1_000_000_000n,
              totalSecuritization: 1_000_000_000n,
              vaultSecuritizationPositions: {},
            }),
        },
      },
    });
    const frames = createRevenueMiningFrames([21, 20], () => ({ api, specVersion: 160 }));
    Object.assign(frames.blockWatch, {
      getHeader: async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` }),
      getApi: async () => parentApi,
    });
    const clients = { get: async () => ({ query: { vaults: { vaultsById: { entries: async () => [] } } } }) };
    const vaults = new Vaults(
      'mainnet',
      {
        fetchMainchainRatesAtBlock: async ({ block }: { block: { blockHash: string } }) => ({
          ARGNOT: block.blockHash === '0x20' ? 10_000n : 20_000n,
        }),
      } as any,
      frames as any,
      clients as any,
    );
    vaults.stats = createStats([createFrame({ totalEarnings: 99n, externalCapital: 100n })]);
    vaults.stats.argonBondsByFrame = [
      { frameId: 1, poolDistributed: 1n },
      { frameId: 20, poolDistributed: 1_000_000n },
    ];
    vaults.stats.revenueBackfill = { nextFrame: 21, throughFrame: 21 };
    await vaults.updateRevenue();
    // One ARGN actually paid over 100 eligible ARGN, rather than the next frame's 10,000 or the target 1,000.
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(365);
    expect(vaults.calculateArgonBondsApr(1)).toBeCloseTo(365);
    expect(vaults.stats.argonotStakingByFrame[0]).toMatchObject({
      frameId: 20,
      participatingBonds: 100,
      microgonsPerArgonot: 10_000n,
      poolDistributed: 1_000_000n,
    });
    expect(vaults.calculateArgonotStakingApr()).toBeCloseTo(36_500);

    frames.frameIds[0] = 22;
    frames.currentFrameId = 22;
    frames.framesById[22] = { firstBlockHash: '0x22' };
    const payout = events[0].event;
    if (payout.method === 'FrameEarningsDistributed') {
      events[0] = { ...events[0], event: { ...payout, data: { ...payout.data, frameId: 21 } } };
    }
    await expect(vaults.updateRevenue()).rejects.toThrow('missing its Argonot payout participants');
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(365);
    expect(vaults.calculateArgonotStakingApr()).toBeCloseTo(36_500);
    expect(vaults.stats.synchedToFrame).toBe(20);

    participantsFrame = 21;
    await expect(vaults.updateRevenue()).rejects.toThrow('missing its Argon bond payout capital');
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(365);
    expect(vaults.calculateArgonotStakingApr()).toBeCloseTo(36_500);
    expect(vaults.stats.synchedToFrame).toBe(20);

    capitalFrame = 21;
    await vaults.updateRevenue();
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(365);
    expect(vaults.stats.argonBondsByFrame).toHaveLength(3);
    expect(vaults.calculateArgonotStakingApr()).toBeCloseTo(24_333.333333);
    expect(vaults.stats.synchedToFrame).toBe(21);

    // An unavailable old denominator stays unknown; it must not restart archive scans on ordinary updates.
    api.query.vaults.revenuePerFrameByVault.entries = async () => {
      throw new Error('Unexpected old history scan');
    };
    await vaults.updateRevenue();
    expect(vaults.stats.revenueBackfill).toBeUndefined();
    expect(vaults.stats.argonBondsByFrame?.find(frame => frame.frameId === 1)?.participatingBonds).toBeUndefined();
  });

  it('stores the latest completed frame when the current frame has finalized blocks', async () => {
    vi.useFakeTimers();

    const revenue = {
      frameId: 19,
      bitcoinLockFeeRevenue: 100n,
      bitcoinLockFeeCouponValueUsed: 0n,
      treasuryTotalEarnings: 0n,
      treasuryVaultEarnings: 0n,
      treasuryExternalCapital: 0n,
      treasuryVaultCapital: 0n,
      securitization: 1_000n,
    };
    const api = {
      query: {
        treasury: {},
        vaults: {
          revenuePerFrameByVault: {
            entries: async () => [[{ args: [1] }, [revenue, { ...revenue, frameId: 20, bitcoinLockFeeRevenue: 900n }]]],
          },
        },
      },
    };
    const miningFrames = {
      load: vi.fn().mockResolvedValue(undefined),
      currentFrameId: 20,
      frameIds: [20],
      framesById: { 20: { firstBlockHash: '0x20' } },
      getFrameStart: vi.fn().mockResolvedValue({
        frame: {
          firstBlockSpecVersion: 200,
          firstBlockNumber: 100,
          firstBlockHash: '0x20',
          firstBlockTick: 1_000,
        },
        api,
      }),
      blockWatch: { finalizedBlockHeader: { blockNumber: 100 } },
    };
    const mainchainClients = {
      get: vi.fn().mockResolvedValue({
        query: {
          vaults: {
            vaultsById: { entries: vi.fn().mockResolvedValue([]) },
          },
        },
      }),
    };
    const vaults = new Vaults('mainnet', {} as any, miningFrames as any, mainchainClients as any);
    vaults.stats = createStats([
      createFrame({ frameId: 19, bitcoinFeeRevenue: 1n, bitcoinFeeCouponValueUsed: 0n, securitization: 1_000n }),
    ]);
    vaults.stats.synchedToFrame = 18;

    await vaults.updateRevenue();

    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    expect(vaults.stats.synchedToFrame).toBe(19);
    expect(vaults.calculateApr()).toBeCloseTo(3_650);
  });

  it('saves each 20-frame revenue batch and resumes the next batch after restart', async () => {
    vi.useFakeTimers();

    const apiAtFrame = (observedAtFrame: number) => ({
      query: {
        treasury: {},
        vaults: {
          revenuePerFrameByVault: {
            entries: vi.fn().mockResolvedValue([
              [
                { args: [1] },
                Array.from({ length: 10 }, (_, index) => ({
                  frameId: observedAtFrame - index - 1,
                  bitcoinLocksNewLiquidityPromised: 0n,
                  bitcoinLocksReleasedLiquidity: 0n,
                  bitcoinLocksAddedSatoshis: 0n,
                  bitcoinLocksReleasedSatoshis: 0n,
                  bitcoinLockFeeRevenue: BigInt(observedAtFrame - index - 1),
                  bitcoinLockFeeCouponValueUsed: 0n,
                  bitcoinLocksCreated: 0,
                  treasuryTotalEarnings: 0n,
                  treasuryVaultEarnings: 0n,
                  treasuryExternalCapital: 0n,
                  treasuryVaultCapital: 0n,
                  securitization: 0n,
                  securitizationActivated: 0n,
                  securitizationRelockable: 0n,
                  uncollectedRevenue: 0n,
                })),
              ],
            ]),
          },
        },
      },
    });
    const mainchainClients = {
      get: vi.fn().mockResolvedValue({
        query: {
          vaults: {
            vaultsById: { entries: vi.fn().mockResolvedValue([]) },
          },
        },
      }),
    };
    const firstReadFrames: number[] = [];
    const frameIds = Array.from({ length: 41 }, (_, index) => 40 - index);
    const firstMiningFrames = createRevenueMiningFrames(frameIds, frameId => {
      firstReadFrames.push(frameId);
      return { api: apiAtFrame(frameId), specVersion: 200 };
    });
    const firstVaults = new Vaults('mainnet', {} as any, firstMiningFrames as any, mainchainClients as any);
    firstVaults.stats = createStats([
      createFrame({ frameId: 10, bitcoinFeeRevenue: 1n }),
      createFrame({ frameId: 9, bitcoinFeeRevenue: 9n }),
    ]);
    firstVaults.stats.formatVersion = VAULT_STATS_FORMAT_VERSION;
    firstVaults.stats.synchedToFrame = 9;
    let persistedStats: IAllVaultStats | undefined;
    vi.spyOn(firstVaults as any, 'saveStats').mockImplementation(async () => {
      persistedStats = structuredClone(firstVaults.stats);
    });

    await firstVaults.updateRevenue();

    expect(firstReadFrames).toEqual(Array.from({ length: 20 }, (_, index) => 40 - index));
    expect(persistedStats).toMatchObject({
      synchedToFrame: 39,
      revenueBackfill: { nextFrame: 20, throughFrame: 11 },
    });
    expect(persistedStats?.vaultsById[1].changesByFrame[0].bitcoinFeeRevenue).toBe(39n);
    expect(persistedStats?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 10)?.bitcoinFeeRevenue).toBe(
      1n,
    );
    vi.clearAllTimers();

    const secondReadFrames: number[] = [];
    const secondMiningFrames = createRevenueMiningFrames(frameIds, frameId => {
      secondReadFrames.push(frameId);
      return { api: apiAtFrame(frameId), specVersion: 200 };
    });
    const secondVaults = new CachedVaults(
      structuredClone(persistedStats!),
      secondMiningFrames as any,
      mainchainClients as any,
    );

    await secondVaults.load();
    expect(secondReadFrames).toEqual([]);
    await vi.runOnlyPendingTimersAsync();

    vi.clearAllTimers();
    vi.useRealTimers();

    expect(secondReadFrames).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    expect(secondVaults.stats).toMatchObject({
      synchedToFrame: 39,
    });
    expect(secondVaults.stats?.revenueBackfill).toBeUndefined();
    expect(secondVaults.stats?.vaultsById[1].changesByFrame[0].bitcoinFeeRevenue).toBe(39n);
    expect(
      secondVaults.stats?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 10)?.bitcoinFeeRevenue,
    ).toBe(10n);
    expect(secondVaults.stats?.vaultsById[1].changesByFrame.find(frame => frame.frameId === 9)?.bitcoinFeeRevenue).toBe(
      9n,
    );

    const revenueHistory = secondVaults.stats!.vaultsById[1].changesByFrame;
    const savedFrame = revenueHistory.find(frame => frame.frameId === 35)!;
    const savedFees = savedFrame.bitcoinFeeRevenue;
    frameIds.unshift(41);
    secondMiningFrames.currentFrameId = 41;
    secondMiningFrames.framesById[41] = { firstBlockHash: '0x41' };
    secondReadFrames.length = 0;

    await secondVaults.updateRevenue();

    expect(secondReadFrames).toEqual([41]);
    expect(secondVaults.stats?.vaultsById[1].changesByFrame[0]).toMatchObject({ frameId: 40, bitcoinFeeRevenue: 40n });
    expect(
      secondVaults.stats!.vaultsById[1].changesByFrame.find(frame => frame.frameId === 35)?.bitcoinFeeRevenue,
    ).toBe(savedFees);
  });
});

describe('Vault and bond network returns', () => {
  it('uses the inclusive return window for coupon-net vault income and recorded external bond earnings', () => {
    const vaults = createVaults();
    vaults.vaultsById[1] = {
      securitization: 1_000n,
      terms: { treasuryProfitSharing: 0.99 },
    } as any;
    const includedFrame = {
      bitcoinFeeRevenue: 100n,
      bitcoinFeeCouponValueUsed: 40n,
      securitization: 1_000n,
      externalCapital: 1_000n,
      totalEarnings: 100n,
      vaultEarnings: 40n,
    };
    const excludedFrame = {
      bitcoinFeeRevenue: 10_000n,
      bitcoinFeeCouponValueUsed: 0n,
      securitization: 1n,
      externalCapital: 1n,
      totalEarnings: 10_000n,
    };
    vaults.stats = createStats([
      createFrame({ frameId: 10, ...excludedFrame }),
      createFrame({ frameId: 11, ...includedFrame }),
      createFrame({ frameId: 20, ...includedFrame }),
      createFrame({ frameId: 21, ...excludedFrame }),
    ]);

    expect(vaults.calculateApr()).toBeCloseTo(3_650);
    expect(vaults.calculateApy()).toBeCloseTo((1.1 ** 365 - 1) * 100);
    expect(vaults.calculateVaultApr(1)).toBeCloseTo(3_650);
    expect(vaults.calculateVaultApy(1)).toBeCloseTo((1.1 ** 365 - 1) * 100);
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(2_190);
  });

  it('weights global and single-vault returns by recorded frame capital', () => {
    const vaults = createVaults();
    vaults.stats = {
      synchedToFrame: 20,
      argonotStakingByFrame: [],
      vaultsById: {
        1: createVaultStats([
          createFrame({
            frameId: 20,
            bitcoinFeeRevenue: 100n,
            bitcoinFeeCouponValueUsed: 0n,
            securitization: 1_000n,
            externalCapital: 1_000n,
            totalEarnings: 60n,
          }),
        ]),
        2: createVaultStats([
          createFrame({
            frameId: 20,
            bitcoinFeeCouponValueUsed: 0n,
            securitization: 9_000n,
            externalCapital: 9_000n,
          }),
        ]),
      },
    };

    expect(vaults.calculateVaultApr(1)).toBeCloseTo(3_650);
    expect(vaults.calculateVaultApr(2)).toBe(0);
    expect(vaults.calculateApr()).toBeCloseTo(365);
    expect(vaults.calculateArgonBondsApr(1)).toBeCloseTo(2_190);
    expect(vaults.calculateArgonBondsApr(2)).toBe(0);
    expect(vaults.calculateArgonBondsApr()).toBeCloseTo(219);
  });

  it('records current coupon usage and preserves missing historical coupon data', async () => {
    const vaults = createVaults();
    const frameRevenue = {
      frameId: 20,
      bitcoinLocksNewLiquidityPromised: 0n,
      bitcoinLocksReleasedLiquidity: 0n,
      bitcoinLocksAddedSatoshis: 0n,
      bitcoinLocksReleasedSatoshis: 0n,
      bitcoinLockFeeRevenue: 100n,
      bitcoinLockFeeCouponValueUsed: 40n,
      bitcoinLocksCreated: 0,
      treasuryTotalEarnings: 0n,
      treasuryVaultEarnings: 0n,
      treasuryExternalCapital: 0n,
      treasuryVaultCapital: 0n,
      securitization: 1_000n,
      securitizationActivated: 1_000n,
      securitizationRelockable: 0n,
      uncollectedRevenue: 0n,
    };
    const { bitcoinLockFeeCouponValueUsed: _coupon, ...historicalFrameRevenue } = {
      ...frameRevenue,
      frameId: 19,
    };

    await vaults.updateVaultRevenue(1, [frameRevenue, historicalFrameRevenue] as any);

    expect(vaults.stats?.vaultsById[1].changesByFrame[0].bitcoinFeeCouponValueUsed).toBe(40n);
    expect(vaults.stats?.vaultsById[1].changesByFrame[1].bitcoinFeeCouponValueUsed).toBeUndefined();
  });

  it('rejects vault returns with missing coupon usage without affecting bond returns', () => {
    const incompleteVaults = createVaults();
    incompleteVaults.stats = createStats([
      createFrame({
        bitcoinFeeRevenue: 100n,
        externalCapital: 1_000n,
        totalEarnings: 100n,
        vaultEarnings: 40n,
      }),
    ]);
    expect(() => incompleteVaults.calculateApr()).toThrow('coupon');
    expect(incompleteVaults.calculateArgonBondsApr()).toBeCloseTo(2_190);
  });

  it('does not manufacture returns from zero-capital frames', () => {
    const vaults = createVaults();
    vaults.stats = createStats([
      createFrame({
        bitcoinFeeRevenue: 100n,
        bitcoinFeeCouponValueUsed: 0n,
        totalEarnings: 100n,
        vaultEarnings: 40n,
      }),
    ]);

    expect(vaults.calculateApr()).toBe(0);
    expect(vaults.calculateApy()).toBe(0);
    expect(vaults.calculateArgonBondsApr()).toBe(0);
  });

  it('projects yearly treasury revenue from the last 365 frames regardless of frame duration', () => {
    NetworkConfig.setNetwork('dev-docker');
    const vaults = createVaults();
    vaults.stats = createStats([
      createFrame({ frameId: 35, externalCapital: 1n, totalEarnings: 10_000n }),
      createFrame({ frameId: 36, externalCapital: 1_000n, totalEarnings: 100n }),
      createFrame({ frameId: 400, externalCapital: 3_000n, totalEarnings: 300n }),
    ]);
    vaults.stats.synchedToFrame = 400;

    expect(
      vaults.calculateTreasuryYearlyRevenue({
        vaultId: 1,
        capital: 2_000n,
        operatorKeepPct: 25,
      }),
    ).toBe(18_250n);
  });

  it('calculates Argonot staking APR from historical frame rewards and price-valued capital', () => {
    const vaults = createVaults();
    vaults.stats = {
      formatVersion: VAULT_STATS_FORMAT_VERSION,
      synchedToFrame: 20,
      argonotStakingByFrame: [
        {
          frameId: 20,
          poolDistributed: 100n,
          participatingBonds: 10,
          microgonsPerArgonot: 100n,
        },
        {
          frameId: 19,
          poolDistributed: 900n,
          participatingBonds: 10,
          microgonsPerArgonot: 900n,
        },
        {
          frameId: 10,
          poolDistributed: 1_000_000n,
          participatingBonds: 1,
          microgonsPerArgonot: 1n,
        },
      ],
      vaultsById: {},
    };

    expect(vaults.calculateArgonotStakingApr()).toBeCloseTo(3_650);
  });

  it('returns zero Argonot staking APR without price-valued participating capital', () => {
    const vaults = createVaults();
    vaults.stats = {
      formatVersion: VAULT_STATS_FORMAT_VERSION,
      synchedToFrame: 20,
      argonotStakingByFrame: [
        {
          frameId: 20,
          poolDistributed: 100n,
          participatingBonds: 0,
          microgonsPerArgonot: 100n,
        },
      ],
      vaultsById: {},
    };

    expect(vaults.calculateArgonotStakingApr()).toBe(0);
  });

  it('calculates restabilization leverage from caller-supplied circulation', () => {
    expect(
      calculateRestabilizationLeverage({
        argonBurnCapacity: 25,
        microgonsInCirculation: 10_000_000n,
      }),
    ).toBe(2.5);
    expect(
      calculateRestabilizationLeverage({
        argonBurnCapacity: 25,
        microgonsInCirculation: 0n,
      }),
    ).toBe(0);
  });
});

class CachedVaults extends Vaults {
  constructor(
    private readonly cachedStats: IAllVaultStats,
    miningFrames: any,
    mainchainClients: any,
  ) {
    super('mainnet', {} as any, miningFrames, mainchainClients);
  }

  protected async loadStatsFromFile(): Promise<IAllVaultStats> {
    return this.cachedStats;
  }
}

function createVaults(): Vaults {
  return new Vaults('mainnet', {} as any, {} as any, {} as any);
}

function createStats(frames: IVaultFrameStats[]): IAllVaultStats {
  return {
    synchedToFrame: 20,
    argonotStakingByFrame: [],
    vaultsById: {
      1: createVaultStats(frames),
    },
  };
}

function createRevenueMiningFrames(
  frameIds: number[],
  readFrame: (frameId: number) => { api: unknown; specVersion: number },
) {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    currentFrameId: frameIds[0],
    frameIds,
    framesById: Object.fromEntries(frameIds.map(frameId => [frameId, { firstBlockHash: `0x${frameId}` }])),
    getFrameStart: vi.fn(async (frameId: number) => {
      const { api, specVersion } = readFrame(frameId);
      return {
        frame: {
          firstBlockSpecVersion: specVersion,
          firstBlockNumber: frameId,
          firstBlockHash: `0x${frameId}`,
          firstBlockTick: frameId * 10,
        },
        api,
      };
    }),
    blockWatch: { finalizedBlockHeader: { blockNumber: 1_000 } },
  };
}

function createVaultStats(frames: IVaultFrameStats[]): IVaultStats {
  return {
    openedTick: 0,
    baseline: {
      feeRevenue: 0n,
      satoshis: 0n,
      bitcoinLocks: 0,
      microgonLiquidityRealized: 0n,
    },
    changesByFrame: frames,
  };
}

function createFrame(
  overrides: Partial<Omit<IVaultFrameStats, 'treasuryPool'>> & Partial<IVaultFrameStats['treasuryPool']> = {},
): IVaultFrameStats {
  const {
    externalCapital = 0n,
    vaultCapital = 0n,
    totalEarnings = 0n,
    vaultEarnings = 0n,
    ...frameOverrides
  } = overrides;

  return {
    frameId: 20,
    bitcoinFeeRevenue: 0n,
    satoshisAdded: 0n,
    bitcoinLocksCreated: 0,
    microgonLiquidityAdded: 0n,
    securitization: 0n,
    securitizationActivated: 0n,
    treasuryPool: {
      externalCapital,
      vaultCapital,
      totalEarnings,
      vaultEarnings,
    },
    uncollectedEarnings: 0n,
    ...frameOverrides,
  };
}
