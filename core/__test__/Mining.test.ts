import { beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { EventEmitter } from 'node:events';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { Currency } from '../src/Currency.ts';
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
  it('estimates frame income from observed wins, preserves historical valuation, and bounds archive reads', async () => {
    NetworkConfig.setRuntimeOverride('mainnet', { genesisTick: 0, ticksBetweenFrames: 4 });
    const cohorts = [
      [createCohortKey(12), [createMember('miner-1')]],
      [
        createCohortKey(13),
        ['miner-2', 'miner-3', 'miner-4'].map(address => ({ ...createMember(address), bid: 300n })),
      ],
    ];
    type Payouts = HistoricalQueryRecord<'blockRewards', 'payoutsByBlock'>;
    const payouts = new Map<number, Payouts>(
      (
        [
          [1, 10n, 2n, 'seal-miner-1'],
          [2, 20n, 3n, 'seal-miner-1'],
          [3, 10n, 3n, 'seal-miner-1'],
          [4, 5n, 1n, 'seal-miner-1'],
          [5, 40n, 5n, 'seal-miner-2'],
          [6, 5n, 1n, 'seal-miner-1'],
        ] as const
      ).map(([block, argons, ownership, blockSealAuthority]) => [
        block,
        [{ accountId: 'shared-recipient', argons, ownership, blockSealAuthority, rewardType: { type: 'Miner' } }],
      ]),
    );
    let latestPrice = 5;
    let failFrame = false;
    let latestBlock = 6;
    const snapshots = (blockNumber: number) => ({
      consts: {
        blockRewards: {
          minerPayoutPercent: new BigNumber(0.5),
          startingOwnershipTokensPerBlock: 10n,
          halvingBeginTicks: 1_000_000,
          halvingTicks: 1_000_000,
          incrementalGrowth: [0n, 1_000n, 10n],
        },
      },
      query: {
        system: { number: vi.fn().mockResolvedValue(blockNumber) },
        priceIndex: {
          current: vi.fn(
            async (): Promise<HistoricalQueryRecord<'priceIndex', 'current'>> => ({
              btcUsdPrice: new BigNumber(100),
              argonUsdPrice: new BigNumber(1),
              argonUsdTargetPrice: new BigNumber(1),
              argonotUsdPrice: new BigNumber(blockNumber >= 6 ? latestPrice : [1, 3, 2, 2, 2, 4][blockNumber]),
              argonTimeWeightedAverageLiquidity: new BigNumber(0),
              tick: blockNumber,
            }),
          ),
        },
        blockRewards: {
          blockRewardsByCohort: vi.fn().mockResolvedValue([
            [12, 10n],
            [13, 20n],
            [14, 30n],
          ]),
          payoutsByBlock: Object.assign(
            vi.fn(async (block: number) => payouts.get(block) ?? []),
            {
              entries: vi.fn(async () =>
                [...payouts]
                  .filter(([number]) => number <= blockNumber && number > blockNumber - 5)
                  .map(([number, values]) => [{ args: [number] }, values] as const),
              ),
            },
          ),
        },
        miningSlot: {
          activeMinersCount: vi.fn().mockResolvedValue(blockNumber < 5 ? 2 : 4),
          nextFrameId: vi.fn().mockResolvedValue(blockNumber < 5 ? 13 : 14),
          frameRewardTicksRemaining: vi.fn().mockResolvedValue(blockNumber >= 7 ? 2 : 3),
          frameStartBlockNumbers: vi.fn().mockResolvedValue([5, 1]),
          minerNonceScoringByCohort: vi.fn(
            async (): Promise<HistoricalQueryRecord<'miningSlot', 'minerNonceScoringByCohort'>> => {
              if (blockNumber === 7 && failFrame) throw new Error('Mining frame temporarily unavailable');
              const blocksWonInFrame = blockNumber < 5 ? Math.max(0, blockNumber - 1) : Math.min(blockNumber - 5, 2);
              return {
                12: [{ nonce: 1n, lastWinBlock: blockNumber, blocksWonInFrame, frameStartBlocksWonSurplus: 0n }],
              };
            },
          ),
          minersByCohort: {
            entries: vi.fn().mockResolvedValue(
              blockNumber === 0
                ? [
                    [createCohortKey(2), cohorts[0][1]],
                    [createCohortKey(3), [createMember('miner-2')]],
                  ]
                : blockNumber < 5
                  ? [cohorts[0], [createCohortKey(3), [createMember('miner-2')]]]
                  : cohorts,
            ),
          },
        },
        mint: {
          miningMintPerCohort: vi.fn().mockResolvedValue(blockNumber < 5 ? {} : { 12: 9n }),
        },
        ticks: { currentTick: vi.fn().mockResolvedValue(blockNumber) },
      },
    });
    const api = snapshots(6);
    const client = {
      query: {
        blockRewards: {
          payoutsByBlock: {
            entriesAt: vi.fn(async (hash: string) =>
              snapshots(Number(hash)).query.blockRewards.payoutsByBlock.entries(),
            ),
            at: vi.fn(async (_hash: string, block: number) => payouts.get(block) ?? []),
          },
        },
      },
      rpc: {
        chain: {
          getFinalizedHead: vi.fn(async () => String(latestBlock)),
          getBlockHash: vi.fn(async (block: number) =>
            getOfflineRegistry().createType('Hash', `0x${block.toString(16).padStart(64, '0')}`),
          ),
        },
      },
      at: vi.fn(async (hash: string) => (hash === '6' ? api : snapshots(Number(hash)))),
    };
    const clients = {
      prunedClientPromise: Promise.resolve(client),
      archiveClientPromise: Promise.resolve(client),
      events: new EventEmitter(),
    };
    const mining = new Mining(clients as any);
    const stats = new GlobalMiningStats(mining, new Currency(clients as any));

    await stats.update();

    // The two activation payouts belong to retired cohorts 2 and 3, including renewed authorities.
    // Cohort 12: three closed-frame wins * (5 ARGN + 5 ARGNOT * 2) = 45;
    // current income = 5 + 5 * 5 + 9 expansion; remaining projection = 18 + 8 * 30.
    // Cohort 13: remaining projection = 77 + 9 * 105. Entry stakes stay at prices 3 and 4.
    expect(stats.aggregatedBlockRewards).toBe(1_364n);
    expect(stats.investedCapital).toBe(1_750n);
    expect(stats.projectedProfit).toBe(364n);
    expect(stats.activeTDR).toBeCloseTo((492 / 250 - 1 + (1_622 / 1_500 - 1)) * 50);
    expect(stats.averageAPR).toBeCloseTo((492 / 250 - 1 + (1_622 / 1_500 - 1)) * 50 * 36.5);
    expect(stats.averageAPY).toBeCloseTo((((492 / 250) ** 36.5 - 1) * 100 + ((1_622 / 1_500) ** 36.5 - 1) * 100) / 2);
    expect(stats.activeAPR).toBe(stats.averageAPR);
    expect(stats.activeAPY).toBe(stats.averageAPY);
    expect(stats.activeSeatCount).toBe(4);
    expect(stats.aggregatedBidCosts).toBe(1_000n);
    expect(stats.baseMicrogonRewardsPerBlock).toBe(8n);
    expect(stats.baseMicronotRewardsPerBlock).toBe(5n);
    await expect(mining.fetchAggregateBlockRewards(api as any)).resolves.toEqual({ microgons: 350n, micronots: 200n });

    latestPrice = 6;
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_558n);
    expect(stats.investedCapital).toBe(1_750n);
    expect(stats.projectedProfit).toBe(558n);

    // Refresh failure preserves a usable quote; retry publishes the newer absolute counters once.
    latestBlock = 7;
    failFrame = true;
    await expect(stats.update()).rejects.toThrow('Mining frame temporarily unavailable');
    expect(stats.aggregatedBlockRewards).toBe(1_558n);
    expect(stats.investedCapital).toBe(1_750n);
    failFrame = false;
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_555n);
    latestBlock = 8; // A compute block does not add another mining win.
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_555n);
    expect(stats.projectedProfit).toBe(555n);

    // A long frame with no more reward ticks must still use only its boundary snapshots.
    latestBlock = 10_000;
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_555n);
    expect(client.query.blockRewards.payoutsByBlock.entriesAt).not.toHaveBeenCalled();
    expect(client.query.blockRewards.payoutsByBlock.at).not.toHaveBeenCalled();
    expect(new Set(client.rpc.chain.getBlockHash.mock.calls.map(([block]) => block))).toEqual(
      new Set([0, 1, 4, 5, 6, 7, 8, 10_000]),
    );

    // A surviving cohort also receives the exact activation payout, once, outside reset counters.
    const activationPayout = { ...payouts.get(5)![0], blockSealAuthority: 'seal-miner-1' };
    payouts.set(5, [
      activationPayout,
      { ...activationPayout, argons: 999n, ownership: 999n, rewardType: { type: 'Voter' } },
      { ...activationPayout, argons: 999n, ownership: 999n, rewardType: { type: 'ProfitShare' } },
    ]);
    const survivingCohortStats = new GlobalMiningStats(new Mining(clients as any), new Currency(clients as any));
    await survivingCohortStats.update();
    expect(survivingCohortStats.aggregatedBlockRewards).toBe(1_625n);
    expect(survivingCohortStats.projectedProfit).toBe(625n);
  });

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
        fetchActiveCohortStats: vi.fn().mockResolvedValue([
          {
            startingFrameId: 1,
            seatCount: 4,
            bidCosts: 1_000n,
            micronotsStaked: 200n,
            blockRewards: { microgons: 875n, micronots: 500n },
            entryArgonotPrice: 2_000_000n,
            frameRewards: [{ frameId: 1, microgons: 875n, micronots: 500n, argonotPrice: 2_000_000n }],
          },
        ]),
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
      fetchActiveCohortStats: vi.fn().mockResolvedValue([
        {
          startingFrameId: 1,
          seatCount: 4,
          bidCosts: 1_000n,
          micronotsStaked: 200n,
          blockRewards: { microgons: 1_750n, micronots: 1_000n },
          entryArgonotPrice: 2_000_000n,
          frameRewards: [{ frameId: 1, microgons: 1_750n, micronots: 1_000n, argonotPrice: 2_000_000n }],
        },
      ]),
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

  it.each([
    { state: 'empty network', cohorts: [] },
    {
      state: 'zero-capital cohort',
      cohorts: [
        {
          startingFrameId: 1,
          seatCount: 1,
          bidCosts: 0n,
          micronotsStaked: 0n,
          blockRewards: { microgons: 100n, micronots: 0n },
          entryArgonotPrice: 0n,
          frameRewards: [{ frameId: 1, microgons: 100n, micronots: 0n, argonotPrice: 0n }],
        },
      ],
    },
  ])('returns zero rates when no active mining capital exists: $state', async ({ cohorts }) => {
    const api = {};
    const mining = {
      prunedClientOrArchivePromise: Promise.resolve({
        rpc: { chain: { getFinalizedHead: vi.fn().mockResolvedValue('0xfinalized') } },
        at: vi.fn().mockResolvedValue(api),
      }),
      fetchActiveMinersCount: vi.fn().mockResolvedValue(cohorts.length),
      fetchActiveCohortStats: vi.fn().mockResolvedValue(cohorts),
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
