import { beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { GlobalMiningStats } from '../src/GlobalMiningStats.ts';
import { Mining, normalizeMiningSeatSlots } from '../src/Mining.ts';
import { BotActivityType, type IHistoryFile } from '../src/interfaces/IHistoryFile.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';

beforeEach(() => {
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.clearRuntimeOverride('mainnet');
});

describe('Mining auction bid activity', () => {
  it('knows there were no personal bids in an empty network auction without saved activity', () => {
    expect(Mining.summarizeBidHistory({ activities: [] }, 0)).toEqual({
      acceptedBidCount: 0,
      maximumMicrogons: undefined,
    });
    expect(Mining.summarizeBidHistory(undefined, 0)).toEqual({ acceptedBidCount: 0, maximumMicrogons: undefined });
    expect(Mining.summarizeBidHistory({ activities: [] }, 10)).toBeUndefined();
    expect(Mining.summarizeBidHistory({ activities: [] })).toBeUndefined();
  });

  it('counts accepted bids and ignores fully rejected prices when finding the maximum', () => {
    const history: IHistoryFile = {
      activities: [
        {
          id: 1,
          tick: 1,
          type: BotActivityType.BidsSubmitted,
          data: { submittedCount: 2, microgonsPerSeat: 20n, txFeePlusTip: 1n },
        },
        {
          id: 2,
          tick: 2,
          type: BotActivityType.BidsRejected,
          data: { submittedCount: 3, rejectedCount: 2, microgonsPerSeat: 15n },
        },
        {
          id: 3,
          tick: 3,
          type: BotActivityType.BidsRejected,
          data: { submittedCount: 4, rejectedCount: 4, microgonsPerSeat: 50n },
        },
      ],
    };
    expect(Mining.summarizeBidHistory(history, 9)).toEqual({ acceptedBidCount: 3, maximumMicrogons: 20n });
    // A stale network response must not replace recorded accepted bids with zero.
    expect(Mining.summarizeBidHistory(history, 0)).toEqual({ acceptedBidCount: 3, maximumMicrogons: 20n });
  });
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
          nextCohortSize: vi.fn().mockResolvedValue(17),
          nextFrameId: vi.fn().mockResolvedValue(13),
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
          minerPayoutPercent: new BigNumber(0.5),
          halvingBeginTicks: 1_000_000,
          halvingTicks: 1_000_000,
          incrementalGrowth: [0n, 1_000n, 100n],
        },
      },
      query: {
        blockRewards: {
          blockRewardsByCohort: vi.fn().mockResolvedValue([
            [1, 100n],
            [2, 200n],
            [3, 300n],
          ]),
        },
        miningSlot: {
          activeMinersCount: vi.fn().mockResolvedValue(4),
          frameRewardTicksRemaining: vi.fn().mockResolvedValue(1),
          minersByCohort: {
            entries: vi.fn().mockResolvedValue(cohorts),
          },
        },
        ticks: {
          currentTick: vi.fn().mockResolvedValue(2),
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
          activeMinersCount: vi.fn().mockResolvedValue(0),
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

  it.each(['mainnet', 'dev-docker'] as const)(
    'values retained ARGNOT and treats ten frames as ten return days on %s',
    async network => {
      NetworkConfig.setNetwork(network);
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
      expect(stats.investedCapital).toBe(1_400n);
      expect(stats.projectedProfit).toBe(875n);
      expect(stats.activeBidCosts).toBe(stats.aggregatedBidCosts);
      expect(stats.activeBlockRewards).toBe(stats.aggregatedBlockRewards);
      expect(stats.activeTDR).toBe(62.5);
      expect(stats.averageAPR).toBeCloseTo(2_281.25);
      expect(stats.averageAPY).toBeCloseTo((1.625 ** 36.5 - 1) * 100);
      expect(stats.activeAPR).toBe(stats.averageAPR);
      expect(stats.activeAPY).toBe(stats.averageAPY);
      expect(mining.fetchActiveMinersCount).toHaveBeenCalledWith(api);
      expect(mining.fetchAggregateBlockRewards).toHaveBeenCalledWith(api);
      expect(mining.fetchAggregateBidCosts).toHaveBeenCalledWith(api);
      expect(mining.fetchAggregateMicronotsStaked).toHaveBeenCalledWith(api);
    },
  );

  it('exposes base rewards as per-block values', async () => {
    NetworkConfig.setRuntimeOverride('mainnet', {
      genesisTick: 0,
      ticksBetweenFrames: 2,
    });

    const api = {};
    const mining = {
      prunedClientOrArchivePromise: Promise.resolve({
        rpc: { chain: { getFinalizedHead: vi.fn().mockResolvedValue('0xfinalized') } },
        at: vi.fn().mockResolvedValue(api),
      }),
      fetchActiveMinersCount: vi.fn().mockResolvedValue(4),
      fetchAggregateBlockRewards: vi.fn().mockResolvedValue({ microgons: 1_750n, micronots: 1_000n }),
      fetchAggregateBidCosts: vi.fn().mockResolvedValue(1_000n),
      fetchAggregateMicronotsStaked: vi.fn().mockResolvedValue(200n),
    };
    const currency = {
      load: vi.fn().mockResolvedValue(undefined),
      convertMicronotTo: vi.fn((value: bigint) => value * 2n),
    };
    const stats = new GlobalMiningStats(mining as any, currency as any);

    await stats.load();

    expect(NetworkConfig.ticksPerCohort).toBe(20);
    expect(stats.baseMicrogonRewardsPerBlock).toBe(87n);
    expect(stats.baseMicronotRewardsPerBlock).toBe(50n);
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
    expect(stats.activeTDR).toBe(0);
    expect(stats.activeAPR).toBe(0);
    expect(stats.activeAPY).toBe(0);
  });
});

function createCohortKey(startingFrameId: number) {
  return { args: [startingFrameId] };
}

function createMember(address: string) {
  return {
    accountId: address,
    externalFundingAccount: 'managed-account',
    bid: 100n,
    argonots: 50n,
  };
}

function createBid(startingFrameId: number, address: string) {
  return {
    startingFrameId,
    accountId: address,
    bid: 200n,
    argonots: 75n,
  };
}
