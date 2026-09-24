import BigNumber from 'bignumber.js';
import { nextTick, reactive, shallowReactive, watchEffect } from 'vue';
import type { VaultsVaultsByIdResultSpec159Variant15 } from '@argonprotocol/runtime-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '../src/Deferred.ts';
import { calculateRestabilizationLeverage } from '../src/GlobalVaultingStats.ts';
import type { IAllVaultStats, IVaultFrameStats, IVaultStats } from '../src/interfaces/IVaultStats.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { VAULT_STATS_FORMAT_VERSION, Vaults } from '../src/Vaults.ts';

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
    expect(vaults.currentState).toEqual({ isLoaded: true, isLoading: false, error: '' });
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

  it('finishes loading before operator profile names are available', async () => {
    const operatorAccountId = `0x${'02'.repeat(32)}`;
    const operationalAccountId = `0x${'01'.repeat(32)}`;
    const profileEntries = createDeferred<any[]>();
    const client = {
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
  it('stores the latest completed frame when the current frame has finalized blocks', async () => {
    vi.useFakeTimers();

    const api = {
      query: {
        treasury: {},
        vaults: {
          revenuePerFrameByVault: { entries: vi.fn().mockResolvedValue([]) },
        },
      },
    };
    const miningFrames = {
      load: vi.fn().mockResolvedValue(undefined),
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
    vaults.stats = createStats([]);
    vaults.stats.synchedToFrame = 18;

    await vaults.updateRevenue();

    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    expect(vaults.stats.synchedToFrame).toBe(19);
  });

  it('saves each 20-frame revenue batch and resumes the next batch after restart', async () => {
    vi.useFakeTimers();

    let revenueFrameId = 10;
    const apiAtFrame = (observedAtFrame: number) => ({
      query: {
        treasury: {},
        vaults: {
          revenuePerFrameByVault: {
            entries: vi.fn().mockResolvedValue([
              [
                { args: [1] },
                [
                  {
                    frameId: revenueFrameId,
                    bitcoinLocksNewLiquidityPromised: 0n,
                    bitcoinLocksReleasedLiquidity: 0n,
                    bitcoinLocksAddedSatoshis: 0n,
                    bitcoinLocksReleasedSatoshis: 0n,
                    bitcoinLockFeeRevenue: BigInt(observedAtFrame),
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
                  },
                ],
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
      return { api: apiAtFrame(frameId), specVersion: frameId === 14 ? 144 : 200 };
    });
    const firstVaults = new Vaults('mainnet', {} as any, firstMiningFrames as any, mainchainClients as any);
    firstVaults.stats = createStats([]);
    firstVaults.stats.formatVersion = VAULT_STATS_FORMAT_VERSION;
    firstVaults.stats.synchedToFrame = 0;
    let persistedStats: IAllVaultStats | undefined;
    vi.spyOn(firstVaults as any, 'saveStats').mockImplementation(async () => {
      persistedStats = structuredClone(firstVaults.stats);
    });

    await firstVaults.updateRevenue();

    expect(firstReadFrames).toEqual(Array.from({ length: 20 }, (_, index) => 40 - index));
    expect(persistedStats).toMatchObject({
      synchedToFrame: 39,
      revenueBackfill: { nextFrame: 20, throughFrame: 1 },
    });
    expect(persistedStats?.vaultsById[1].changesByFrame[0].bitcoinFeeRevenue).toBe(40n);
    vi.clearAllTimers();

    const secondReadFrames: number[] = [];
    const secondMiningFrames = createRevenueMiningFrames(frameIds, frameId => {
      secondReadFrames.push(frameId);
      return { api: apiAtFrame(frameId), specVersion: frameId === 14 ? 144 : 200 };
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

    expect(secondReadFrames).toEqual([20, 19, 18, 17, 16, 15, 14]);
    expect(secondVaults.stats).toMatchObject({
      synchedToFrame: 39,
    });
    expect(secondVaults.stats?.revenueBackfill).toBeUndefined();
    expect(secondVaults.stats?.vaultsById[1].changesByFrame[0].bitcoinFeeRevenue).toBe(40n);

    const revenueHistory = secondVaults.stats!.vaultsById[1].changesByFrame;
    revenueHistory.push({ ...revenueHistory[0], frameId: 35, bitcoinFeeRevenue: 35n });
    revenueFrameId = 35;
    frameIds.unshift(41);
    secondMiningFrames.currentFrameId = 41;
    secondMiningFrames.framesById[41] = { firstBlockHash: '0x41' };
    secondReadFrames.length = 0;

    await secondVaults.updateRevenue();

    expect(secondReadFrames).toEqual(Array.from({ length: 13 }, (_, index) => 41 - index));
    expect(revenueHistory.find(frame => frame.frameId === 35)?.bitcoinFeeRevenue).toBe(41n);
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
