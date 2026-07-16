import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalMiningStats } from '../src/GlobalMiningStats.ts';
import { Mining, normalizeMiningSeatSlots } from '../src/Mining.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { bigintCodec, numberCodec } from './helpers/codecs.ts';

beforeEach(() => {
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.clearRuntimeOverride('mainnet');
});

describe('Mining seat slot construction', () => {
  it('uses the next cohort size only for the upcoming auction slot', async () => {
    const api = {
      query: {
        miningSlot: {
          minersByCohort: {
            entries: vi.fn().mockResolvedValue([
              [createCohortKey(1), [createMember('miner-1'), createMember('miner-2')]],
              [createCohortKey(13), [createMember('miner-3')]],
            ]),
          },
          bidsForNextSlotCohort: vi.fn().mockResolvedValue([createBid(13, 'bidder-1')]),
          nextCohortSize: vi.fn().mockResolvedValue(numberCodec(17)),
          nextFrameId: vi.fn().mockResolvedValue(numberCodec(13)),
        },
      },
    };

    const slots = await Mining.fetchMiningSeats('managed-account', api as any);
    const slotsById = new Map(slots.map(slot => [slot.slotId, slot]));

    expect(slotsById.get(1)?.seats).toHaveLength(10);
    expect(slotsById.get(3)?.seats).toHaveLength(17);
    expect(slotsById.get(7)?.seats).toHaveLength(10);
  });

  it('trims legacy empty seats to the ten-seat minimum outside the auction slot', () => {
    const occupiedSeat = { miner: { address: 'miner-1' }, bid: null };
    const emptySeat = { miner: null, bid: null };
    const legacySeats = [occupiedSeat, ...Array.from({ length: 16 }, () => emptySeat)];
    const slots = [
      { slotId: 0, seats: [...legacySeats] },
      { slotId: 1, seats: [...legacySeats] },
    ] as any;

    const normalized = normalizeMiningSeatSlots(slots, 0);

    expect(normalized.map(slot => slot.seats.length)).toEqual([17, 10]);
  });
});

describe('Mining network returns', () => {
  it('uses every active cohort, the actual active count, and the runtime payout for both currencies', async () => {
    NetworkConfig.setRuntimeOverride('mainnet', {
      genesisTick: 0,
      ticksBetweenFrames: 1,
    });

    const cohorts = [
      [createCohortKey(1), [createMember('miner-1')]],
      [createCohortKey(2), [createMember('miner-2'), createMember('miner-3'), createMember('miner-4')]],
    ];
    const api = {
      consts: {
        blockRewards: {
          minerPayoutPercent: bigintCodec(500_000_000_000_000_000n),
          halvingBeginTicks: numberCodec(1_000_000),
          halvingTicks: numberCodec(1_000_000),
          incrementalGrowth: [bigintCodec(0n), numberCodec(1_000), bigintCodec(100n)],
        },
      },
      query: {
        blockRewards: {
          blockRewardsByCohort: vi.fn().mockResolvedValue([
            [numberCodec(1), bigintCodec(100n)],
            [numberCodec(2), bigintCodec(200n)],
            [numberCodec(3), bigintCodec(300n)],
          ]),
        },
        miningSlot: {
          activeMinersCount: vi.fn().mockResolvedValue(numberCodec(4)),
          frameRewardTicksRemaining: vi.fn().mockResolvedValue(numberCodec(1)),
          minersByCohort: {
            entries: vi.fn().mockResolvedValue(cohorts),
          },
        },
        ticks: {
          currentTick: vi.fn().mockResolvedValue(numberCodec(2)),
        },
      },
    };
    const mining = new Mining({
      prunedClientPromise: Promise.resolve(api),
      prunedClientOrArchivePromise: Promise.resolve(api),
    } as any);

    await expect(mining.fetchActiveMinersCount(api as any)).resolves.toBe(4);
    await expect(mining.fetchAggregateBlockRewards(api as any)).resolves.toEqual({
      microgons: 875n,
      micronots: 500n,
    });
    await expect(mining.fetchAggregateBidCosts(api as any)).resolves.toBe(400n);
    await expect(mining.fetchAggregateMicronotsStaked(api as any)).resolves.toBe(200n);
  });

  it('returns no aggregate block rewards when there are no active miners', async () => {
    const api = {
      query: {
        blockRewards: {
          blockRewardsByCohort: vi.fn().mockResolvedValue([]),
        },
        miningSlot: {
          activeMinersCount: vi.fn().mockResolvedValue(numberCodec(0)),
          minersByCohort: {
            entries: vi.fn().mockResolvedValue([]),
          },
        },
      },
    };
    const mining = new Mining({
      prunedClientPromise: Promise.resolve(api),
      prunedClientOrArchivePromise: Promise.resolve(api),
    } as any);

    await expect(mining.fetchAggregateBlockRewards(api as any)).resolves.toEqual({
      microgons: 0n,
      micronots: 0n,
    });
  });

  it('values retained ARGNOT as capital while preserving bid and reward display totals', async () => {
    const api = {};
    const mining = {
      prunedClientOrArchivePromise: Promise.resolve({
        rpc: { chain: { getFinalizedHead: vi.fn().mockResolvedValue('0xfinalized') } },
        at: vi.fn().mockResolvedValue(api),
      }),
      fetchActiveMinersCount: vi.fn().mockResolvedValue(4),
      fetchAggregateBlockRewards: vi.fn().mockResolvedValue({ microgons: 875n, micronots: 500n }),
      fetchAggregateBidCosts: vi.fn().mockResolvedValue(1_000n),
      fetchAggregateMicronotsStaked: vi.fn().mockResolvedValue(200n),
    };
    const currency = {
      load: vi.fn().mockResolvedValue(undefined),
      convertMicronotTo: vi.fn((value: bigint) => value * 2n),
    };
    const stats = new GlobalMiningStats(mining as any, currency as any);

    await stats.load();

    expect(stats.activeSeatCount).toBe(4);
    expect(stats.aggregatedBidCosts).toBe(1_000n);
    expect(stats.aggregatedBlockRewards).toBe(1_875n);
    expect(stats.activeBidCosts).toBe(stats.aggregatedBidCosts);
    expect(stats.activeBlockRewards).toBe(stats.aggregatedBlockRewards);
    expect(stats.averageAPR).toBeCloseTo(2_281.25);
    expect(stats.activeAPR).toBe(stats.averageAPR);
    expect(stats.activeAPY).toBe(stats.averageAPY);
    expect(mining.fetchActiveMinersCount).toHaveBeenCalledWith(api);
    expect(mining.fetchAggregateBlockRewards).toHaveBeenCalledWith(api);
    expect(mining.fetchAggregateBidCosts).toHaveBeenCalledWith(api);
    expect(mining.fetchAggregateMicronotsStaked).toHaveBeenCalledWith(api);
  });

  it('returns zero rates when no active mining capital exists', async () => {
    const api = {};
    const mining = {
      prunedClientOrArchivePromise: Promise.resolve({
        rpc: { chain: { getFinalizedHead: vi.fn().mockResolvedValue('0xfinalized') } },
        at: vi.fn().mockResolvedValue(api),
      }),
      fetchActiveMinersCount: vi.fn().mockResolvedValue(0),
      fetchAggregateBlockRewards: vi.fn().mockResolvedValue({ microgons: 0n, micronots: 0n }),
      fetchAggregateBidCosts: vi.fn().mockResolvedValue(0n),
      fetchAggregateMicronotsStaked: vi.fn().mockResolvedValue(0n),
    };
    const currency = {
      load: vi.fn().mockResolvedValue(undefined),
      convertMicronotTo: vi.fn(() => 0n),
    };
    const stats = new GlobalMiningStats(mining as any, currency as any);

    await stats.load();

    expect(stats.averageAPR).toBe(0);
    expect(stats.averageAPY).toBe(0);
    expect(stats.activeAPR).toBe(0);
    expect(stats.activeAPY).toBe(0);
  });
});

function createCohortKey(startingFrameId: number) {
  return { args: [numberCodec(startingFrameId)] };
}

function createMember(address: string) {
  return {
    accountId: { toHuman: () => address },
    externalFundingAccount: { value: { toHuman: () => 'managed-account' } },
    bid: { toBigInt: () => 100n },
    argonots: bigintCodec(50n),
  };
}

function createBid(startingFrameId: number, address: string) {
  return {
    startingFrameId: numberCodec(startingFrameId),
    accountId: { toHuman: () => address },
    bid: { toBigInt: () => 200n },
    argonots: bigintCodec(75n),
  };
}
