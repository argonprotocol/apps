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
  it('prices completed frames at their close, projects unfinished rewards at the latest price, and freezes entry stakes', async () => {
    NetworkConfig.setRuntimeOverride('mainnet', { genesisTick: 0, ticksBetweenFrames: 4 });
    const cohorts = [
      [createCohortKey(12), [createMember('miner-1')]],
      [
        createCohortKey(13),
        ['miner-2', 'miner-3', 'miner-4'].map(address => ({ ...createMember(address), bid: 300n })),
      ],
    ];
    type Payouts = HistoricalQueryRecord<'blockRewards', 'payoutsByBlock'>;
    const payouts = new Map<number, Payouts>([
      [
        1,
        [
          {
            accountId: 'shared-recipient',
            argons: 10n,
            ownership: 2n,
            rewardType: { type: 'Miner' },
            blockSealAuthority: 'seal-miner-1',
          },
        ],
      ],
      [
        2,
        [
          {
            accountId: 'shared-recipient',
            argons: 20n,
            ownership: 3n,
            rewardType: { type: 'Miner' },
            blockSealAuthority: 'seal-miner-1',
          },
          {
            accountId: 'shared-recipient',
            argons: 999n,
            ownership: 999n,
            rewardType: { type: 'Voter' },
            blockSealAuthority: null,
          },
        ],
      ],
      [
        3,
        [
          {
            accountId: 'shared-recipient',
            argons: 40n,
            ownership: 5n,
            rewardType: { type: 'Miner' },
            blockSealAuthority: 'seal-miner-2',
          },
        ],
      ],
      [
        4,
        [
          {
            accountId: 'shared-recipient',
            argons: 5n,
            ownership: 1n,
            rewardType: { type: 'Miner' },
            blockSealAuthority: 'seal-miner-1',
          },
          {
            accountId: 'shared-recipient',
            argons: 999n,
            ownership: 999n,
            rewardType: { type: 'ProfitShare' },
            blockSealAuthority: 'seal-miner-1',
          },
        ],
      ],
    ]);
    let latestPrice = 5;
    let failPayout = false;
    let latestBlock = 4;
    const snapshots = (blockNumber: number) => ({
      consts: {
        blockRewards: {
          minerPayoutPercent: new BigNumber(0.5),
          halvingBeginTicks: 1_000_000,
          halvingTicks: 1_000_000,
          incrementalGrowth: [0n, 1_000n, 10n],
        },
      },
      query: {
        system: { number: vi.fn().mockResolvedValue(blockNumber) },
        priceIndex: {
          current: vi.fn(async (): Promise<HistoricalQueryRecord<'priceIndex', 'current'>> => {
            return {
              btcUsdPrice: new BigNumber(100),
              argonUsdPrice: new BigNumber(1),
              argonUsdTargetPrice: new BigNumber(1),
              argonotUsdPrice: new BigNumber(blockNumber >= 4 ? latestPrice : [1, 3, 2, 4][blockNumber]),
              argonTimeWeightedAverageLiquidity: new BigNumber(0),
              tick: blockNumber,
            };
          }),
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
              entries: vi.fn(async () => {
                if (blockNumber === 5 && failPayout) throw new Error('Historical payout temporarily unavailable');
                return [...payouts]
                  .filter(([number]) => number <= blockNumber && number > blockNumber - 5)
                  .map(([number, values]) => [{ args: [number] }, values] as const);
              }),
            },
          ),
        },
        miningSlot: {
          activeMinersCount: vi.fn().mockResolvedValue(4),
          nextFrameId: vi.fn().mockResolvedValue(blockNumber < 3 ? 13 : 14),
          frameRewardTicksRemaining: vi.fn().mockResolvedValue(blockNumber >= 5 ? 1 : 2),
          frameStartBlockNumbers: vi.fn().mockResolvedValue([3, 1]),
          minersByCohort: {
            entries: vi.fn().mockResolvedValue(
              blockNumber === 0
                ? [
                    [createCohortKey(2), cohorts[0][1]],
                    [createCohortKey(3), cohorts[1][1]],
                  ]
                : blockNumber < 3
                  ? [cohorts[0], [createCohortKey(3), cohorts[1][1]]]
                  : cohorts,
            ),
          },
        },
        mint: {
          miningMintPerCohort: vi.fn().mockResolvedValue(blockNumber < 3 ? {} : { 12: 9n }),
        },
        ticks: { currentTick: vi.fn().mockResolvedValue(blockNumber >= 5 ? 7 : 6) },
      },
    });
    const api = snapshots(4);
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
      at: vi.fn(async (hash: string) => (hash === '4' ? api : snapshots(Number(hash)))),
    };
    const clients = {
      prunedClientPromise: Promise.resolve(client),
      archiveClientPromise: Promise.resolve(client),
      events: new EventEmitter(),
    };
    const mining = new Mining(clients as any);
    const currency = new Currency(clients as any);
    currency.microgonsPer = { ...currency.microgonsPer, ARGNOT: 5_000_000n };
    const stats = new GlobalMiningStats(mining, currency);

    await stats.update();

    // Activation-block payouts belong to retired cohorts 2 and 3, not renewed seats 12 and 13.
    // Cohort 12: closed-frame income 26 + current income 19 + remaining projection 252 = 297.
    // Cohort 13: no current income + remaining projection 995 = 995.
    // Stakes enter at 3 and 4 ARGN/ARGNOT, independent of the latest rate of 5.
    expect(stats.aggregatedBlockRewards).toBe(1_292n);
    expect(stats.investedCapital).toBe(1_750n);
    expect(stats.projectedProfit).toBe(292n);
    expect(stats.activeTDR).toBeCloseTo((447 / 250 - 1 + (1_595 / 1_500 - 1)) * 50);
    expect(stats.averageAPR).toBeCloseTo(1_553.6833333333334);
    expect(stats.averageAPY).toBeCloseTo(((1.788 ** 36.5 - 1) * 100 + ((1_595 / 1_500) ** 36.5 - 1) * 100) / 2);
    expect(stats.activeAPR).toBe(stats.averageAPR);
    expect(stats.activeAPY).toBe(stats.averageAPY);
    expect(stats.activeSeatCount).toBe(4);
    expect(stats.aggregatedBidCosts).toBe(1_000n);
    expect(stats.baseMicrogonRewardsPerBlock).toBe(8n);
    expect(stats.baseMicronotRewardsPerBlock).toBe(5n);
    await expect(mining.fetchAggregateBlockRewards(api as any)).resolves.toEqual({ microgons: 350n, micronots: 200n });

    // Changing today's quote must not reprice already-sold rewards or committed stakes.
    latestPrice = 6;
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_477n);
    expect(stats.investedCapital).toBe(1_750n);
    expect(stats.projectedProfit).toBe(477n);

    // A failed incremental historical read preserves the last complete quote.
    payouts.set(5, [
      {
        accountId: 'shared-recipient',
        argons: 1n,
        ownership: 0n,
        rewardType: { type: 'Miner' },
        blockSealAuthority: 'seal-miner-1',
      },
    ]);
    latestBlock = 5;
    failPayout = true;
    await expect(stats.update()).rejects.toThrow('Historical payout temporarily unavailable');
    expect(stats.aggregatedBlockRewards).toBe(1_477n);
    expect(stats.investedCapital).toBe(1_750n);
    failPayout = false;
    latestBlock = 6; // A finalized block without a payout must not add or duplicate income.
    await stats.update();
    expect(stats.aggregatedBlockRewards).toBe(1_439n);
    expect(stats.projectedProfit).toBe(439n);
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
