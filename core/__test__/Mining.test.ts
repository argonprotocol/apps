import { beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { projectMiningReturns, type IMiningFrameEstimate } from '../src/GlobalMiningStats.ts';
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
  it('applies the miner cut to bootstrap ARGN rewards', async () => {
    const mining = new Mining({} as any);
    const api = {
      consts: { blockRewards: { startingArgonsPerBlock: 11n, minerPayoutPercent: new BigNumber(0.5) } },
    };
    await expect(mining.fetchMicrogonsPerBlockForMiner(api as any, 1)).resolves.toBe(5n);
  });

  it.each([
    { start: 102, end: 109, expected: 14n },
    { start: 109, end: 114, expected: 19n },
    { start: 114, end: 123, expected: 21n },
    { start: 122, end: 125, expected: 3n },
  ])(
    'sums the ARGNOT schedule over growth and halving boundaries: $start to $end',
    async ({ start, end, expected }) => {
      NetworkConfig.setRuntimeOverride('mainnet', { genesisTick: 101, ticksBetweenFrames: 4 });
      const api = {
        consts: {
          blockRewards: {
            startingOwnershipTokensPerBlock: 3n,
            incrementalGrowth: [2n, 3n, 9n],
            halvingBeginTicks: 9,
            halvingTicks: 6,
            minerPayoutPercent: new BigNumber(0.5),
          },
        },
      };
      const mining = new Mining({} as any);
      // Raw rewards at elapsed ticks 0..2, 3..5, 6..8, 9..14, 15..20, 21.. are 3,5,7,9,4,3.
      // Apply the miner cut per block (1,2,3,4,2,1) before summing, as the runtime does.
      await expect(mining.minimumMicronotsMinedDuringTickRange(start, end, api as any)).resolves.toBe(expected);
    },
  );

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
    'sells mined ARGNOT daily and annualizes ten financial days on %s',
    network => {
      NetworkConfig.setNetwork(network);
      const unit = 1_000_000n;
      const cohort = {
        startingFrameId: 1,
        seatCount: 1,
        bidCosts: 5n * unit,
        micronotsStaked: 2n * unit,
        blockRewards: { microgons: 10n * unit, micronots: 10n * unit },
      };
      const days = new Map([
        [1, frameEstimate(1, unit, 10n * unit)],
        [2, frameEstimate(2, unit, 10n * unit)],
        [3, frameEstimate(3, unit, unit)],
      ]);
      const input = {
        cohorts: [cohort],
        frameEstimates: days,
        currentFrameId: 3,
        currentPrice: unit,
        mintedByCohort: {},
      };
      const quote = projectMiningReturns(input);
      // Two daily sales at10 plus eight forecast sales at1, and10 scheduled ARGN.
      expect(quote.aggregatedBlockRewards).toBe(38n * unit);
      expect(quote.investedCapital).toBe(25n * unit);
      expect(quote.projectedProfit).toBe(33n * unit);
      expect(quote.averageAPY / (((58 / 25) ** 36.5 - 1) * 100)).toBeCloseTo(1, 12);
      expect(projectMiningReturns({ ...input, currentPrice: 2n * unit }).aggregatedBlockRewards).toBe(46n * unit);
      // More competition today changes future per-seat income, preserving completed sales.
      days.set(3, frameEstimate(3, unit / 2n, unit));
      expect(projectMiningReturns(input).aggregatedBlockRewards).toBe(34n * unit);
      days.set(3, frameEstimate(3, unit, unit));
      days.set(4, frameEstimate(4, unit, unit));
      expect(projectMiningReturns({ ...input, currentFrameId: 4 }).aggregatedBlockRewards).toBe(38n * unit);
      const minted = projectMiningReturns({ ...input, mintedByCohort: { 1: 7n * unit } });
      expect(minted.projectedProfit).toBe(40n * unit);
      expect(projectMiningReturns({ ...input, mintedByCohort: { 1: 7n * unit } }).projectedProfit).toBe(
        minted.projectedProfit,
      );
    },
  );

  it('keeps earlier daily reward rates instead of averaging a changed schedule over the term', () => {
    const unit = 1_000_000n;
    const quote = projectMiningReturns({
      cohorts: [
        {
          startingFrameId: 1,
          seatCount: 1,
          bidCosts: unit,
          micronotsStaked: 0n,
          blockRewards: { microgons: 0n, micronots: 0n },
        },
      ],
      frameEstimates: new Map([
        [1, frameEstimate(1, 10n * unit, 10n * unit)],
        [2, frameEstimate(2, 10n * unit, 10n * unit)],
        [3, frameEstimate(3, unit, unit)],
      ]),
      currentFrameId: 3,
      currentPrice: unit,
      mintedByCohort: {},
    });
    expect(quote.aggregatedBlockRewards).toBe(208n * unit);
  });

  it('returns zero rates for an empty network or a free seat', () => {
    const input = {
      frameEstimates: new Map([[1, frameEstimate(1, 0n, 0n)]]),
      currentFrameId: 1,
      currentPrice: 0n,
      mintedByCohort: {},
    };
    for (const cohorts of [
      [],
      [
        {
          startingFrameId: 1,
          seatCount: 1,
          bidCosts: 0n,
          micronotsStaked: 0n,
          blockRewards: { microgons: 100n, micronots: 0n },
        },
      ],
    ]) {
      const quote = projectMiningReturns({ ...input, cohorts });
      expect(quote.averageAPR).toBe(0);
      expect(quote.averageAPY).toBe(0);
    }
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
    authorityKeys: { grandpa: `grandpa-${address}`, blockSealAuthority: `seal-${address}` },
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

function frameEstimate(frameId: number, micronotsPerSeat: bigint, argonotPrice: bigint): IMiningFrameEstimate {
  return {
    frameId,
    blockNumber: frameId,
    blockHash: `0x${frameId.toString(16).padStart(64, '0')}`,
    micronotsPerSeat,
    argonotPrice,
  };
}
