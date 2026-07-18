import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateRestabilizationLeverage } from '../src/GlobalVaultingStats.ts';
import type { IAllVaultStats, IVaultFrameStats, IVaultStats } from '../src/interfaces/IVaultStats.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { VAULT_STATS_FORMAT_VERSION, Vaults } from '../src/Vaults.ts';
import { bigintCodec, numberCodec } from './helpers/codecs.ts';

beforeEach(() => {
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.clearRuntimeOverride('mainnet');
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

    expect(mainchainClients.get).toHaveBeenCalledTimes(2);
    expect(miningFrames.load).toHaveBeenCalledTimes(2);
    expect(client.query.vaults.vaultsById.entries).toHaveBeenCalledOnce();
    expect(vaults.stats?.synchedToFrame).toBe(0);
  });

  it('replaces an old local cache with the published stats version', async () => {
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
    const vaults = new CachedVaults(cachedStats, miningFrames, mainchainClients);

    await vaults.load();

    expect(vaults.stats).not.toBe(cachedStats);
    expect(vaults.stats?.formatVersion).toBe(VAULT_STATS_FORMAT_VERSION);
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
    expect(vaults.calculateBondsApr()).toBeCloseTo(2_190);
  });

  it('weights global and single-vault returns by recorded frame capital', () => {
    const vaults = createVaults();
    vaults.stats = {
      synchedToFrame: 20,
      vaultsById: {
        1: createVaultStats([
          createFrame({
            frameId: 20,
            bitcoinFeeRevenue: 100n,
            bitcoinFeeCouponValueUsed: 0n,
            securitization: 1_000n,
          }),
        ]),
        2: createVaultStats([
          createFrame({
            frameId: 20,
            bitcoinFeeCouponValueUsed: 0n,
            securitization: 9_000n,
          }),
        ]),
      },
    };

    expect(vaults.calculateVaultApr(1)).toBeCloseTo(3_650);
    expect(vaults.calculateVaultApr(2)).toBe(0);
    expect(vaults.calculateApr()).toBeCloseTo(365);
  });

  it('records current coupon usage and preserves missing historical coupon data', async () => {
    const vaults = createVaults();
    const frameRevenue = {
      frameId: numberCodec(20),
      bitcoinLocksNewLiquidityPromised: bigintCodec(0n),
      bitcoinLocksReleasedLiquidity: bigintCodec(0n),
      bitcoinLocksAddedSatoshis: bigintCodec(0n),
      bitcoinLocksReleasedSatoshis: bigintCodec(0n),
      bitcoinLockFeeRevenue: bigintCodec(100n),
      bitcoinLockFeeCouponValueUsed: bigintCodec(40n),
      bitcoinLocksCreated: numberCodec(0),
      treasuryTotalEarnings: bigintCodec(0n),
      treasuryVaultEarnings: bigintCodec(0n),
      treasuryExternalCapital: bigintCodec(0n),
      treasuryVaultCapital: bigintCodec(0n),
      securitization: bigintCodec(1_000n),
      securitizationActivated: bigintCodec(1_000n),
      securitizationRelockable: bigintCodec(0n),
      uncollectedRevenue: bigintCodec(0n),
    };
    const { bitcoinLockFeeCouponValueUsed: _coupon, ...historicalFrameRevenue } = {
      ...frameRevenue,
      frameId: numberCodec(19),
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
    expect(incompleteVaults.calculateBondsApr()).toBeCloseTo(2_190);
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
    expect(vaults.calculateBondsApr()).toBe(0);
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
    vaultsById: {
      1: createVaultStats(frames),
    },
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
