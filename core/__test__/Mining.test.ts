import { beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { GlobalMiningStats } from '../src/GlobalMiningStats.ts';
import { Mining, normalizeMiningSeatSlots } from '../src/Mining.ts';
import { BotActivityType, type IHistoryFile } from '../src/interfaces/IHistoryFile.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { encodeAddress, getOfflineRegistry } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import type { ArgonCurrentQueryClient } from '../src/MainchainClients.ts';

beforeEach(() => {
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.clearRuntimeOverride('mainnet');
});

describe('Mining auction bid activity', () => {
  it('funds standing maxima in commitment order with freezes, holds, and protected account reserves', async () => {
    const registry = getOfflineRegistry();
    const funder = encodeAddress(new Uint8Array(32).fill(10));
    const miners = [11, 12, 13].map(byte => encodeAddress(new Uint8Array(32).fill(byte)));
    const registrations = registry.createType(
      'Vec<ArgonPrimitivesBlockSealMiningRegistration>',
      miners.map(accountId => ({ accountId, externalFundingAccount: funder, bid: 100_000n })),
    );
    const standing = [2, 1, 3].map(submittedAt =>
      registry.createType('Option<PalletMiningSlotStandingBid>', {
        bid: 100_000n,
        max: 500_000n,
        fixed: false,
        submittedAt,
        position: 0,
      }),
    );
    let balance = { free: 300_000n, reserved: 100_000n, frozen: 220_000n };
    const client = runtimeClient({
      registry,
      consts: { balances: { existentialDeposit: 10_000n }, miningSlot: { bidIncrements: 10_000n } },
      query: {
        miningSlot: {
          bidsForNextSlotCohort: async () => registrations,
          standingBids: { multi: async () => standing },
        },
        system: {
          account: {
            multi: async () => [registry.createType('FrameSystemAccountInfo', { providers: 1, data: balance })],
          },
        },
      },
    }) as unknown as ArgonCurrentQueryClient;
    const bids = await client.query.miningSlot.bidsForNextSlotCohort();
    const maxima = await Mining.fetchBidMaxima(client, bids);
    expect(miners.map(miner => maxima.get(miner)?.fundedMaxMicrogons)).toEqual([100_000n, 280_000n, 100_000n]);
    expect(maxima.get(miners[1])?.maxMicrogons).toBe(500_000n);

    balance = { free: 800_000n, reserved: 0n, frozen: 0n };
    const funded = await Mining.fetchBidMaxima(client, bids);
    expect(miners.map(miner => funded.get(miner)?.fundedMaxMicrogons)).toEqual([490_000n, 500_000n, 100_000n]);
  });

  it('knows accepted bids are zero in an empty auction without inferring missing attempts', () => {
    expect(Mining.summarizeBidHistory({ activities: [] }, 0)).toEqual({
      acceptedBidCount: 0,
    });
    expect(Mining.summarizeBidHistory(undefined, 0)).toEqual({
      acceptedBidCount: 0,
    });
    expect(Mining.summarizeBidHistory({ activities: [] }, 10)).toBeUndefined();
    expect(Mining.summarizeBidHistory({ activities: [] })).toBeUndefined();
  });

  it('counts every submitted bid, including rejected bids, while preserving the accepted maximum', () => {
    const history: IHistoryFile = {
      activities: [
        {
          id: 1,
          tick: 1,
          type: BotActivityType.BidsSubmitted,
          data: { submittedCount: 2, microgonsPerSeat: 20n, maxMicrogonsPerSeat: 40n, txFeePlusTip: 1n },
        },
        {
          id: 2,
          tick: 2,
          type: BotActivityType.BidsRejected,
          data: { submittedCount: 3, rejectedCount: 2, microgonsPerSeat: 15n, maxMicrogonsPerSeat: 30n },
        },
        {
          id: 3,
          tick: 3,
          type: BotActivityType.BidsRejected,
          data: { submittedCount: 4, rejectedCount: 4, microgonsPerSeat: 50n },
        },
      ],
    };
    expect(Mining.summarizeBidHistory(history, 9)).toEqual({
      submittedBidCount: 9,
      acceptedBidCount: 3,
      maximumMicrogons: 40n,
    });
    expect(Mining.summarizeBidHistory({ activities: history.activities.slice(2) }, 0)).toEqual({
      submittedBidCount: 4,
      acceptedBidCount: 0,
      maximumMicrogons: undefined,
    });
    // A stale network response must not replace recorded accepted bids with zero.
    expect(Mining.summarizeBidHistory(history, 0)).toEqual({
      submittedBidCount: 9,
      acceptedBidCount: 3,
      maximumMicrogons: 40n,
    });
    expect(Mining.summarizeBidHistory({ activities: history.activities.slice(1) })).toEqual({
      submittedBidCount: 7,
      acceptedBidCount: 1,
      maximumMicrogons: 30n,
    });
    expect(
      Mining.summarizeBidHistory({
        activities: [
          {
            id: 4,
            tick: 4,
            type: BotActivityType.BidsSubmitted,
            data: { submittedCount: 1, microgonsPerSeat: 15n, txFeePlusTip: 1n },
          },
        ],
      })?.maximumMicrogons,
    ).toBe(15n);
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
