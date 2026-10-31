import {
  Accountset,
  type BlockWatch,
  CohortBidder,
  getRange,
  type ICohortBidderOptions,
  type IBlockHeaderInfo,
  type MiningFrames,
  TransactionEvents,
  type ArgonClient,
  TxResult,
  TxSubmitter,
} from '../src/index.ts';
import { sudo } from '@argonprotocol/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOfflineRegistry, mnemonicGenerate } from '@argonprotocol/mainchain';
import { GenericExtrinsicEra } from '@polkadot/types/extrinsic';
import { createTypedEventEmitter } from '../src/utils.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CohortBidder unit tests', () => {
  let accountset: Accountset;
  const subaccountRange = getRange(0, 49);
  beforeAll(() => {
    accountset = new Accountset({
      client: null as any,
      txSubmitter: sudo(),
      subaccountRange,
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'alice',
    });
  });

  it('increases bids correctly', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid!.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid!.subaccounts.length).toBe(10);
  });

  it('bids with min bid before increment', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(5),
      accountBalance: Argons(51),
      bidIncrement: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(1.0));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid!.microgonsPerSeat).toBe(Argons(5));
    expect(cohortBidder.nextBid!.subaccounts.length).toBe(10);
  });

  it('bids up to max budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(0.51),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('does not bid if next bid is over max', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(0.6),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.6));
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };
    // works fine with

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeUndefined();
    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0]).toMatchObject(
      expect.objectContaining({
        reason: 'max-bid-too-low',
        tick: 10,
      }),
    );
  });

  it('reduces bids to fit budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(4.9),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(4.4));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4.41));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(2);
  });

  it('submits bids for all seats if no others are present', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(4.9),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.5));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('submits zero-value bids when no others are present', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: 0n,
      maxBid: Argons(4.9),
      accountBalance: Argons(1),
    });
    cohortBidder.currentBids.bids = [];
    cohortBidder.currentBids.atTick = 10;

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(0n);
    expect(cohortBidder.nextBid?.subaccounts).toEqual(cohortBidder.subaccounts.map(x => x.address));
  });

  it('can bid up existing seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(4.9),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(6, Argons(4.1)),
      ...cohortBidder.subaccounts.slice(0, 4).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4.11));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('can bid up only some existing seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(4),
      maxBid: Argons(5.5),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 4).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(6, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(6);
  });

  it('can beat out multiple tiers of seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(5.5),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(4, Argons(3.53)),
      ...createBids(2, Argons(3.52)),
      ...createBids(2, Argons(3.51)),
      ...createBids(2, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(3.54));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('can beat out multiple tiers of seats when some are own', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(5.5),
      accountBalance: Argons(40 + 0.06 - 3 * 3.53),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(1, Argons(4.1)),
      ...cohortBidder.subaccounts.slice(0, 3).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(3.53), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(4, Argons(3.51)),
      ...createBids(2, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(6);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(3.52)); // should take available spot
  });

  it('fills empty bids at lowest price when owning high bid', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(10),
      accountBalance: Argons(90 + 0.6),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(10), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(9);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.5)); // should take available spot
  });

  it('can take lower bids if only competing against self', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(10),
      accountBalance: Argons(90 + 0.6),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(10), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(5, Argons(1)),
      ...createBids(4, Argons(0.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(9);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(1.01));
  });

  it('can maximize seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(8),
      bidIncrement: Argons(1),
      accountBalance: Argons(40 + 0.06 - 4),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(2, Argons(10)),
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(3, Argons(4)),
      ...createBids(2, Argons(4)),
      ...createBids(2, Argons(4)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(5));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(8);
  });

  it("should not bid if it doesn't increase seats", async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(8),
      bidIncrement: Argons(1),
      accountBalance: Argons(40 + 0.06 - 4),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(3, Argons(10)),
      ...cohortBidder.subaccounts.slice(0, 7).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeUndefined();
    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0].reason).toBe('max-bid-too-low');
  });

  it('does not bid more seats than its available ARGNOT can fund', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 20_000n,
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(2);
  });

  it('limits additional seats to free ARGNOT when already winning seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 10_000n,
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 2).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(1), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(8, Argons(0.5)),
    ];
    // @ts-expect-error - private var
    cohortBidder.lastLoggedSeatsInBudget = 4;
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(1);

    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0].reason).toBe('insufficient-argonot-balance');
    expect(onBidParamsAdjusted.mock.calls[0][0].availableMicronots).toBe(10_000n);
  });

  it('publishes restored seat capacity after more bot capital becomes available', async () => {
    const options = {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 20_000n,
    };
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], options);
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    const onUpdated = vi.fn();
    cohortBidder.callbacks = { onBidParamsAdjusted };
    cohortBidder.onUpdatedFn = onUpdated;

    // @ts-expect-error - private var
    await cohortBidder.planNextBid();
    expect(onBidParamsAdjusted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSeats: 2,
        reason: 'insufficient-argonot-balance',
      }),
    );

    options.accountMicronots = 100_000n;
    onUpdated.mockClear();
    // @ts-expect-error - private var
    await cohortBidder.planNextBid();

    expect(onBidParamsAdjusted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxSeats: 10,
        reason: undefined,
      }),
    );
    expect(onUpdated).toHaveBeenCalled();
  });

  it('publishes changed bot capital even when capacity is unchanged', async () => {
    const options = {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 100_000n,
    };
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], options);
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    const onUpdated = vi.fn();
    cohortBidder.onUpdatedFn = onUpdated;

    // @ts-expect-error - private var
    await cohortBidder.planNextBid();
    expect(cohortBidder.botCapital).toEqual({
      microgons: Argons(10),
      micronots: 100_000n,
    });

    options.accountBalance = Argons(11);
    options.accountMicronots = 110_000n;
    onUpdated.mockClear();
    // @ts-expect-error - private var
    await cohortBidder.planNextBid();

    expect(cohortBidder.botCapital).toEqual({
      microgons: Argons(11),
      micronots: 110_000n,
    });
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('includes capital locked in winning bids in the published bot capital', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 100_000n,
    });
    cohortBidder.currentBids.bids = [
      {
        address: cohortBidder.subaccounts[0].address,
        bidMicrogons: Argons(0.5),
        micronotsStaked: 10_000n,
        bidAtTick: 10,
      },
      ...createBids(9, Argons(0.5)),
    ];
    cohortBidder.currentBids.atTick = 10;

    // @ts-expect-error - private var
    await cohortBidder.planNextBid();

    expect(cohortBidder.botCapital).toEqual({
      microgons: Argons(10.5),
      micronots: 110_000n,
    });
  });

  it('retries an unchanged bids snapshot after a transient read failure', async () => {
    const header = createBlockHeader(100, `0x${'01'.repeat(32)}`);
    const bidsForNextSlotCohort = vi.fn().mockResolvedValue([]);
    const client = {
      at: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary rpc failure'))
        .mockResolvedValue({
          query: { miningSlot: { bidsForNextSlotCohort } },
        }),
      rpc: {
        state: {
          getStorageHash: vi.fn().mockResolvedValue({ toHex: () => '0xunchanged' }),
        },
      },
    };
    const blockWatch = {
      bestBlockHeader: header,
      subscriptionClient: client,
    };
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as unknown as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      {
        minBid: 500_000n,
        maxBid: 1_000_000n,
        bidIncrement: 10_000n,
        bidDelay: 1,
      },
    );
    // @ts-expect-error setting the storage key for the private header flow
    cohortBidder.bidsForNextSlotCohortKey = '0xbids';
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);

    // @ts-expect-error exercising the private header flow
    await expect(cohortBidder.onHeader(header, false)).rejects.toThrow('temporary rpc failure');
    // @ts-expect-error exercising the private header flow
    await expect(cohortBidder.onHeader(header, false)).resolves.toBeUndefined();

    expect(client.at).toHaveBeenCalledTimes(2);
    expect(bidsForNextSlotCohort).toHaveBeenCalledOnce();
  });

  it('does not publish an older auction snapshot after a newer header finishes first', async () => {
    const olderHeader = createBlockHeader(100, `0x${'61'.repeat(32)}`);
    const newerHeader = createBlockHeader(101, `0x${'62'.repeat(32)}`);
    let resolveOlder!: (bids: { accountId: string; bid: bigint; argonots: bigint; bidAtTick: number }[]) => void;
    const olderBids = new Promise<
      {
        accountId: string;
        bid: bigint;
        argonots: bigint;
        bidAtTick: number;
      }[]
    >(resolve => {
      resolveOlder = resolve;
    });
    const client = {
      rpc: { state: { getStorageHash: async (_key: string, hash: string) => ({ toHex: () => hash }) } },
      at: async (hash: string) => ({
        query: {
          miningSlot: {
            bidsForNextSlotCohort: async () =>
              hash === olderHeader.blockHash
                ? olderBids
                : [{ accountId: 'synthetic-newer', bid: 700_000n, argonots: 10_000n, bidAtTick: 101 }],
          },
        },
      }),
    };
    const blockWatch = { bestBlockHeader: newerHeader, subscriptionClient: client };
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as unknown as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      { minBid: 500_000n, maxBid: 1_000_000n, bidIncrement: 10_000n, bidDelay: 1 },
    );
    // @ts-expect-error setting the storage key for the private header flow
    cohortBidder.bidsForNextSlotCohortKey = '0xbids';
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);

    // @ts-expect-error exercising overlapping production header handlers
    const olderUpdate = cohortBidder.onHeader(olderHeader, false);
    await new Promise(setImmediate);
    // @ts-expect-error exercising overlapping production header handlers
    await cohortBidder.onHeader(newerHeader, false);
    resolveOlder([{ accountId: 'synthetic-older', bid: 500_000n, argonots: 10_000n, bidAtTick: 100 }]);
    await olderUpdate;

    expect(cohortBidder.currentBids.atBlockNumber).toBe(101);
    expect(cohortBidder.currentBids.bids[0].bidMicrogons).toBe(700_000n);
  });

  it('publishes other bidders changes while our maximum bid keeps us out of the auction', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      minBid: 100_000n,
      maxBid: 100_000n,
      accountBalance: 1_000_000n,
    });
    let bid = 1_000_000n;
    const client = {
      rpc: { state: { getStorageHash: async () => ({ toHex: () => `bids-${bid}` }) } },
      at: async () => ({
        query: {
          miningSlot: {
            bidsForNextSlotCohort: async () =>
              Array.from({ length: 10 }, (_, i) => ({
                accountId: `other-${i}`,
                bid,
                argonots: 10_000n,
                bidAtTick: 100,
              })),
          },
        },
      }),
    } as unknown as ArgonClient;
    cohortBidder.miningFrames = { blockWatch: { subscriptionClient: client } } as unknown as MiningFrames;
    // @ts-expect-error private storage key initialized by start
    cohortBidder.bidsForNextSlotCohortKey = '0xbids';
    // @ts-expect-error exercise the real header and planning flow
    await cohortBidder.onHeader(createBlockHeader(100, 'first-bids'), true);
    let visibleBids = structuredClone(cohortBidder.currentBids.bids);
    cohortBidder.onUpdatedFn = () => {
      visibleBids = structuredClone(cohortBidder.currentBids.bids);
    };

    bid = 1_100_000n;
    // @ts-expect-error exercise a subsequent external auction update
    await cohortBidder.onHeader(createBlockHeader(101, 'next-bids'), false);
    expect(visibleBids[0].bidMicrogons).toBe(1_100_000n);
    expect(cohortBidder.nextBid).toBeUndefined();
    expect(cohortBidder.lastBid).toBeUndefined();
    expect(cohortBidder.bidsAttempted).toBe(0);
  });

  it('rebids a newly outbid seat without repeating the configured delay', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      minBid: 500_000n,
      maxBid: 1_000_000n,
      accountBalance: 10_000_000n,
      bidDelay: 100,
    });
    cohortBidder.lastBid = {
      submittedAtTick: 100,
      expectedFinalizationTick: 105,
      isFinalized: true,
      microgonsPerSeat: 500_000n,
      seats: 1,
      seatsWon: 1,
    };
    cohortBidder.currentBids.bids = createBids(10, 600_000n, 101);
    cohortBidder.currentBids.mostRecentBidTick = 101;
    cohortBidder.currentBids.atTick = 101;
    cohortBidder.currentBids.atBlockNumber = 101;

    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(40);

    expect(cohortBidder.nextBid).toMatchObject({ microgonsPerSeat: 610_000n, bidAtTick: 101 });
  });

  it('records an included interrupted batch as rejected and keeps its final fee', async () => {
    const { cohortBidder, blockWatch, client, results, setPoolNonce } = await createBidLifecycleHarness(accountset);
    const onBidsRejected = vi.fn();
    cohortBidder.callbacks = { onBidsRejected };
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    Object.assign(cohortBidder, { lastBidsHash: '0xunchanged', bidsForNextSlotCohortKey: 'bids-key' });
    Object.assign(client.query.miningSlot, { bidsForNextSlotCohort: async () => [] });

    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(40);
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();

    const includedHash = `0x${'53'.repeat(32)}`;
    client.canonicalHashes.set(101, includedHash);
    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(101, includedHash) });
    await results[0].setSeenInBlock(client.api, {
      blockHash: Buffer.from(includedHash.slice(2), 'hex'),
      blockNumber: 101,
      extrinsicIndex: 0,
      events: [
        {
          section: 'utility',
          method: 'BatchInterrupted',
          data: { index: 0, error: { type: 'Token', value: { type: 'FundsUnavailable' } } },
        },
        {
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: 'synthetic-payer', actualFee: 35_000n, tip: 0n },
        },
      ],
    });
    await new Promise(setImmediate);
    expect(cohortBidder.lastBid?.seatsWon).toBe(0);

    // Retry the unchanged auction before the rejected transaction is finalized.
    setPoolNonce(1);
    const nextHeader = createBlockHeader(102, `0x${'54'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: nextHeader });
    // @ts-expect-error exercising the production header and planning flow
    await cohortBidder.onHeader(nextHeader, false);
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1].extrinsic.nonce).toBe(1);

    await results[0].setFinalized(client.api);
    await expect.poll(() => onBidsRejected.mock.calls.length).toBe(1);
    expect(onBidsRejected).toHaveBeenCalledWith(
      expect.objectContaining({ tick: 101, blockNumber: 101, rejectedCount: 1, submittedCount: 1 }),
    );
    expect(cohortBidder.lastBid).toMatchObject({ isFinalized: true, seatsWon: 0 });
    expect(cohortBidder.txFees).toBe(35_000n);
    results[1].submissionError = new Error('test cleanup');
  });

  it('does not let an older finalization overwrite a newer bid record', async () => {
    const currentTick = 100;
    const client = {
      at: vi.fn(),
      query: {
        ticks: {
          currentTick: vi.fn().mockResolvedValue(currentTick),
        },
      },
    };
    client.at.mockResolvedValue(client);
    const blockWatch = {
      bestBlockHeader: createBlockHeader(100, `0x${'01'.repeat(32)}`),
      getHeader: async () => createBlockHeader(100, `0x${'01'.repeat(32)}`),
      subscriptionClient: client,
    };
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as unknown as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      {
        minBid: 500_000n,
        maxBid: 1_000_000n,
        bidIncrement: 10_000n,
        bidDelay: 1,
      },
    );
    const blockHash = new Uint8Array([1]);
    const txResult = new TxResult({
      signedHash: '0x01',
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: 100,
      accountAddress: accountset.txSubmitterPair.address,
      nonce: 0,
    });
    await txResult.setSeenInBlock(client as unknown as ArgonClient, {
      blockHash,
      blockNumber: 100,
      events: [],
      extrinsicIndex: 0,
    });
    txResult.finalFee = 0n;
    const olderBid = {
      submittedAtTick: currentTick,
      expectedFinalizationTick: currentTick + 5,
      isFinalized: false,
      microgonsPerSeat: 500_000n,
      seats: 1,
      seatsWon: 1,
    };
    cohortBidder.lastBid = olderBid;
    const olderAttempt = {
      txResult,
      tip: 0n,
      deathBlock: 108,
      microgonsPerSeat: 500_000n,
      subaccounts: [cohortBidder.subaccounts[0].address],
      inclusion: { blockHash: '0x01', blockNumber: 100 },
    };
    Object.assign(cohortBidder, { activeBidAttempt: olderAttempt, lastBidAttempt: olderAttempt });

    // @ts-expect-error exercising the private finalization flow
    const olderFinalization = cohortBidder.awaitFinalization(olderAttempt);
    await new Promise(setImmediate);

    const newerBid = {
      submittedAtTick: currentTick + 1,
      expectedFinalizationTick: currentTick + 6,
      isFinalized: false,
      microgonsPerSeat: 600_000n,
      seats: 1,
      seatsWon: 1,
    };
    cohortBidder.lastBid = newerBid;
    const newerAttempt = {
      ...olderAttempt,
      inclusion: { blockHash: '0x02', blockNumber: 101 },
    };
    Object.assign(cohortBidder, { activeBidAttempt: newerAttempt, lastBidAttempt: newerAttempt });
    await txResult.setFinalized(client as unknown as ArgonClient);
    await olderFinalization;

    expect(olderBid.isFinalized).toBe(false);
    expect(cohortBidder.lastBid.isFinalized).toBe(false);
    expect(cohortBidder.lastBid.microgonsPerSeat).toBe(600_000n);
  });

  it('does not let an older bid plan overwrite a newer one', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      minBid: 500_000n,
      maxBid: 1_000_000n,
      accountBalance: 1_000_000n,
    });
    // @ts-expect-error constraining the private cohort size for this planning race
    cohortBidder.nextCohortSize = 1;
    let resolveOlderBalance!: (balance: bigint) => void;
    vi.spyOn(accountset, 'balance')
      .mockReset()
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveOlderBalance = resolve;
        }),
      )
      .mockResolvedValue(1_000_000n);
    cohortBidder.currentBids.atTick = 100;

    // @ts-expect-error exercising the private planning flow
    const olderPlan = cohortBidder.planNextBid();
    await new Promise(setImmediate);

    cohortBidder.currentBids.bids = createBids(1, 600_000n, 101);
    cohortBidder.currentBids.atTick = 101;
    cohortBidder.currentBids.mostRecentBidTick = 101;
    // @ts-expect-error exercising the private planning flow
    await cohortBidder.planNextBid();
    resolveOlderBalance(1_000_000n);
    await olderPlan;

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(610_000n);
  });

  it.each([
    {
      currency: 'ARGON',
      eventSection: 'balances',
      initialMicrogons: 500_000n,
      initialMicronots: 100_000n,
    },
    {
      currency: 'ARGNOT',
      eventSection: 'ownership',
      initialMicrogons: 1_000_000n,
      initialMicronots: 0n,
    },
  ])('replans when the funding account receives $currency without new cohort bids', async options => {
    let accountBalance = options.initialMicrogons;
    let accountMicronots = options.initialMicronots;
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      minBid: 500_000n,
      maxBid: 1_000_000n,
      accountBalance,
      accountMicronots,
    });
    vi.spyOn(accountset, 'balance').mockImplementation(() => Promise.resolve(accountBalance));
    vi.spyOn(accountset, 'accountMicronots').mockImplementation(() => Promise.resolve(accountMicronots));
    vi.spyOn(cohortBidder, 'submitNextBid' as any).mockResolvedValue(undefined);
    cohortBidder.currentBids.atBlockNumber = 100;
    cohortBidder.currentBids.atTick = 100;

    // @ts-expect-error exercising the private planning flow
    await cohortBidder.planNextBid(20);
    expect(cohortBidder.nextBid).toBeUndefined();

    accountBalance = 1_000_000n;
    accountMicronots = 100_000n;
    const bidsHash = `0x${'01'.repeat(32)}`;
    const blockWatch = {
      subscriptionClient: {
        rpc: {
          state: {
            getStorageHash: vi.fn().mockResolvedValue({ toHex: () => bidsHash }),
          },
        },
      },
      getEvents: vi.fn().mockResolvedValue([
        {
          event: {
            section: options.eventSection,
            data: { who: accountset.fundingAccountId },
          },
        },
      ]),
    };
    cohortBidder.miningFrames = { blockWatch } as unknown as MiningFrames;
    // @ts-expect-error setting the current private bid hash for an unchanged auction
    cohortBidder.lastBidsHash = bidsHash;
    // @ts-expect-error setting the private storage key used by the header flow
    cohortBidder.bidsForNextSlotCohortKey = 'bids-key';

    // @ts-expect-error exercising the private best-block flow
    await cohortBidder.onHeader(createBlockHeader(101, `0x${'02'.repeat(32)}`), false);

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(500_000n);
    expect(cohortBidder.nextBid?.subaccounts).toHaveLength(1);
  });

  it('reports a bid in progress until an unsuccessful submission resolves', async () => {
    const header = createBlockHeader(100, `0x${'01'.repeat(32)}`);
    const bidsHash = `0x${'02'.repeat(32)}`;
    const blockWatch = {
      bestBlockHeader: header,
      subscriptionClient: {
        rpc: { state: { getStorageHash: vi.fn().mockResolvedValue({ toHex: () => bidsHash }) } },
      },
      getEvents: vi.fn().mockResolvedValue([]),
    };
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as unknown as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      {
        minBid: 500_000n,
        maxBid: 1_000_000n,
        bidIncrement: 10_000n,
        bidDelay: 1,
      },
    );
    cohortBidder.nextBid = {
      microgonsPerSeat: 500_000n,
      subaccounts: [cohortBidder.subaccounts[0].address],
      alreadyWinningSeats: 0,
      bidAtTick: header.tick,
      tip: 0n,
    };
    let rejectCreation!: (error: Error) => void;
    vi.spyOn(accountset, 'createMiningBidTx').mockReturnValue(
      new Promise((_, reject) => {
        rejectCreation = reject;
      }),
    );
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);
    // @ts-expect-error setting the private auction snapshot for an unchanged bid list
    cohortBidder.lastBidsHash = bidsHash;
    // @ts-expect-error setting the private storage key used by the header flow
    cohortBidder.bidsForNextSlotCohortKey = 'bids-key';
    const publishedStates: boolean[] = [];
    cohortBidder.onUpdatedFn = () => publishedStates.push(cohortBidder.isBidInProgress);

    // @ts-expect-error exercising the private best-block flow
    await cohortBidder.onHeader(header, false);
    await new Promise(setImmediate);

    expect(cohortBidder.nextBid).toBeUndefined();
    expect(cohortBidder.isBidInProgress).toBe(true);
    expect(publishedStates).toContain(true);

    rejectCreation(new Error('test cleanup'));
    await vi.waitFor(() => expect(cohortBidder.isBidInProgress).toBe(false));
    expect(publishedStates.at(-1)).toBe(false);
  });

  it('retries snapshot planning when immediate replanning fails after a submission attempt', async () => {
    const header = createBlockHeader(100, `0x${'01'.repeat(32)}`);
    const blockWatch = {
      bestBlockHeader: header,
      subscriptionClient: {},
    };
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as unknown as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      {
        minBid: 500_000n,
        maxBid: 1_000_000n,
        bidIncrement: 10_000n,
        bidDelay: 1,
      },
    );
    cohortBidder.nextBid = {
      microgonsPerSeat: 500_000n,
      subaccounts: [cohortBidder.subaccounts[0].address],
      alreadyWinningSeats: 0,
      bidAtTick: header.tick,
      tip: 0n,
    };
    // @ts-expect-error setting private snapshot state for retry verification
    cohortBidder.lastBidsHash = '0xseen';
    vi.spyOn(accountset, 'createMiningBidTx').mockRejectedValue(new Error('temporary submission failure'));
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockRejectedValue(new Error('temporary planning failure'));
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);

    // @ts-expect-error exercising the private submission flow
    await expect(cohortBidder.submitNextBid()).resolves.toBeUndefined();
    // @ts-expect-error verifying the private snapshot is eligible for retry
    expect(cohortBidder.lastBidsHash).toBeUndefined();
  });

  it.each([
    { finalizedHeight: 99, remaining: 10, period: 16, birth: 92, death: 108 },
    { finalizedHeight: 96, remaining: 8, period: 8, birth: 96, death: 104 },
    { finalizedHeight: 92, remaining: 7, period: 16, birth: 88, death: 104 },
    { finalizedHeight: 99, remaining: 1, period: 8, birth: 96, death: 104 },
  ])('anchors the signed bid to a finalized ancestor ($finalizedHeight, $remaining)', async scenario => {
    const { cohortBidder, blockWatch, client, sign, results } = await createBidLifecycleHarness(accountset);
    const finalizedHash = `0x${'02'.repeat(32)}`;
    const ancestorHash = `0x${'03'.repeat(32)}`;
    Object.assign(blockWatch, {
      bestBlockHeader: { ...blockWatch.bestBlockHeader, frameRewardTicksRemaining: scenario.remaining },
      finalizedBlockHeader: {
        ...createBlockHeader(scenario.finalizedHeight, finalizedHash),
        isFinalized: true,
      },
    });
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(scenario.remaining);
    // @ts-expect-error exercising the private submission flow
    await cohortBidder.submitNextBid();

    const signing = sign.mock.calls[0][1];
    if (!signing.era || typeof signing.era === 'number') throw new Error('Expected a signed mortal era');
    const signedEra = new GenericExtrinsicEra(client.registry, signing.era);
    expect(signing.blockHash).toBe(scenario.birth === scenario.finalizedHeight ? finalizedHash : ancestorHash);
    expect(signedEra.asMortalEra.period.toNumber()).toBe(scenario.period);
    expect(signedEra.asMortalEra.birth(100)).toBe(scenario.birth);
    expect(signedEra.asMortalEra.death(100)).toBe(scenario.death);
    expect(results).toHaveLength(1);
  });

  it('reprices an outbid pending batch at the same nonce and retires the usurped callback', async () => {
    const { cohortBidder, blockWatch, submitSigned, sign, results, setPoolNonce, client } =
      await createBidLifecycleHarness(accountset);
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(20);
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();
    expect(results).toHaveLength(1);
    expect(cohortBidder.isBidInProgress).toBe(true);

    cohortBidder.currentBids.bids = createBids(10, 600_000n, 101);
    cohortBidder.currentBids.atTick = 101;
    cohortBidder.currentBids.atBlockNumber = 101;
    // @ts-expect-error exercising the production auction planner while inclusion is pending
    await cohortBidder.planNextBid(19);
    expect(cohortBidder.nextBid).toMatchObject({ microgonsPerSeat: 610_000n, bidAtTick: 101, tip: 100_000n });
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();

    expect(submitSigned).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[0][1].nonce).toBe(0);
    expect(sign.mock.calls[1][1].nonce).toBe(0);
    expect(sign.mock.calls[1][1].tip).toBe(100_000n);
    expect(cohortBidder.pendingBidTxResult).toBe(results[1]);

    results[0].submissionError = new Error('usurped');
    await new Promise(setImmediate);
    expect(cohortBidder.pendingBidTxResult).toBe(results[1]);
    expect(cohortBidder.isBidInProgress).toBe(true);

    const includedHash = `0x${'12'.repeat(32)}`;
    client.canonicalHashes.set(102, includedHash);
    setPoolNonce(1);
    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(102, includedHash) });
    await results[1].setSeenInBlock(client.api, {
      blockHash: Buffer.from(includedHash.slice(2), 'hex'),
      blockNumber: 102,
      events: [],
      extrinsicIndex: 0,
    });
    await new Promise(setImmediate);
    expect(cohortBidder.lastBid).toMatchObject({ microgonsPerSeat: 610_000n, seatsWon: 1 });

    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(103, `0x${'13'.repeat(32)}`) });
    cohortBidder.currentBids.bids = createBids(10, 700_000n, 103);
    cohortBidder.currentBids.atTick = 103;
    cohortBidder.currentBids.atBlockNumber = 103;
    // @ts-expect-error exercising canonical next-nonce bidding after inclusion
    await cohortBidder.planNextBid(17);
    expect(cohortBidder.nextBid).toMatchObject({ microgonsPerSeat: 710_000n, bidAtTick: 103, tip: 0n });
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();
    expect(sign.mock.calls[2][1]).toMatchObject({ nonce: 1, tip: 0n });
    expect(results[2].extrinsic.nonce).toBe(1);

    await results[1].setFinalized(client.api);
    await new Promise(setImmediate);
    expect(cohortBidder.lastBid?.isFinalized).toBe(true);
    expect(cohortBidder.pendingBidTxResult).toBe(results[2]);
  });

  it('replaces an orphaned bid without Retracted and credits its canonical re-inclusion', async () => {
    const { cohortBidder, blockWatch, client, results, sign } = await createBidLifecycleHarness(accountset);
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(20);
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();

    const orphanHash = `0x${'11'.repeat(32)}`;
    client.canonicalHashes.set(101, orphanHash);
    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(101, orphanHash) });
    await results[0].setSeenInBlock(client.api, {
      blockHash: Buffer.from(orphanHash.slice(2), 'hex'),
      blockNumber: 101,
      events: [],
      extrinsicIndex: 0,
    });
    await new Promise(setImmediate);
    expect(cohortBidder.lastBid?.seatsWon).toBe(1);

    const canonicalHash = `0x${'22'.repeat(32)}`;
    client.canonicalHashes.set(101, canonicalHash);
    const reorgHeader = { ...createBlockHeader(102, `0x${'23'.repeat(32)}`), tick: 102 };
    Object.assign(blockWatch, { bestBlockHeader: reorgHeader });
    cohortBidder.currentBids.bids = createBids(10, 600_000n, 102);
    cohortBidder.currentBids.atTick = 102;
    cohortBidder.currentBids.atBlockNumber = 102;
    // @ts-expect-error preserving an unchanged storage snapshot across the reorg
    cohortBidder.lastBidsHash = '0xunchanged';
    // @ts-expect-error exercising the production best-header flow with no Retracted status
    await cohortBidder.onHeader(reorgHeader, false);
    await expect.poll(() => results.length).toBe(2);
    expect(cohortBidder.lastBid).toBeUndefined();
    expect(sign.mock.calls[1][1].nonce).toBe(0);
    expect(results[1].extrinsic.nonce).toBe(0);
    expect(cohortBidder.pendingBidTxResult).toBe(results[1]);

    const reIncludedHash = `0x${'24'.repeat(32)}`;
    client.canonicalHashes.set(103, reIncludedHash);
    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(104, `0x${'25'.repeat(32)}`) });
    await results[0].setSeenInBlock(client.api, {
      blockHash: Buffer.from(reIncludedHash.slice(2), 'hex'),
      blockNumber: 103,
      events: [],
      extrinsicIndex: 0,
    });
    await results[0].setFinalized(client.api);
    results[1].submissionError = new Error('stale nonce');
    await new Promise(setImmediate);

    expect(cohortBidder.lastBid).toMatchObject({
      submittedAtTick: 103,
      microgonsPerSeat: 500_000n,
      seatsWon: 1,
      isFinalized: true,
    });
    expect(cohortBidder.pendingBidTxResult).toBeUndefined();
  });

  it('records a finalized bid after a transient inclusion-header read failure', async () => {
    const { cohortBidder, blockWatch, client, results } = await createBidLifecycleHarness(accountset);
    const onBidsSubmitted = vi.fn();
    cohortBidder.callbacks = { onBidsSubmitted };
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(40);
    // @ts-expect-error exercising the production submission flow
    await cohortBidder.submitNextBid();

    const includedHash = `0x${'51'.repeat(32)}`;
    client.canonicalHashes.set(101, includedHash);
    Object.assign(blockWatch, { bestBlockHeader: createBlockHeader(101, includedHash) });
    vi.spyOn(blockWatch, 'getHeader')
      .mockRejectedValueOnce(new Error('temporary archive failure'))
      .mockRejectedValueOnce(new Error('temporary archive failure'))
      .mockResolvedValue(createBlockHeader(101, includedHash));
    await results[0].setSeenInBlock(client.api, {
      blockHash: Buffer.from(includedHash.slice(2), 'hex'),
      blockNumber: 101,
      events: [],
      extrinsicIndex: 0,
    });
    await new Promise(setImmediate);
    await results[0].setFinalized(client.api);
    await expect.poll(() => onBidsSubmitted.mock.calls.length).toBe(1);

    expect(onBidsSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ tick: 101, blockNumber: 101, microgonsPerSeat: 500_000n }),
    );
    expect(cohortBidder.lastBid).toMatchObject({ isFinalized: true, seatsWon: 1 });
    expect(cohortBidder.pendingBidTxResult).toBeUndefined();
  });

  it('does not submit signed bytes after the intended auction closes', async () => {
    const { cohortBidder, sign, setBiddingOpen, submitSigned, results } = await createBidLifecycleHarness(accountset);
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(20);

    sign.mockImplementationOnce(async (_signer, options) => {
      setBiddingOpen(false);
      return { era: options.era, nonce: { toNumber: () => 0 } };
    });
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);
    // @ts-expect-error exercising the signing/submission boundary
    await cohortBidder.submitNextBid();

    expect(submitSigned).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
    expect(cohortBidder.pendingBidTxResult).toBeUndefined();
  });

  it.each([
    { finalizedHeight: 0, blockHashCount: 4096 },
    { finalizedHeight: 96, blockHashCount: 8 },
  ])('does not sign when exact mortality has no retained finalized birth ($finalizedHeight)', async scenario => {
    const { cohortBidder, blockWatch, client, sign, submitSigned } = await createBidLifecycleHarness(accountset);
    Object.assign(blockWatch, {
      finalizedBlockHeader: {
        ...createBlockHeader(scenario.finalizedHeight, `0x${'02'.repeat(32)}`),
        isFinalized: true,
      },
    });
    client.consts.system.blockHashCount = scenario.blockHashCount;
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.currentBids.atBlockNumber = 100;
    // @ts-expect-error exercising the production auction planner
    await cohortBidder.planNextBid(40);
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);
    // @ts-expect-error exercising the finalized-birth signing boundary
    await cohortBidder.submitNextBid();

    expect(sign).not.toHaveBeenCalled();
    expect(submitSigned).not.toHaveBeenCalled();
    expect(cohortBidder.pendingBidTxResult).toBeUndefined();
  });

  it('does not search when transaction tracking reports finalization normally', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, includedBlock, txResult } = createBidRecoveryHarness(accountset);
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash');

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    const found = createFoundTransaction(includedBlock);
    await txResult.setSeenInBlock(accountset.client, {
      blockHash: Uint8Array.from({ length: 32 }, () => 1),
      blockNumber: found.blockNumber,
      events: found.extrinsicEvents,
      extrinsicIndex: found.extrinsicIndex,
    });
    await txResult.setFinalized(accountset.client);

    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);
    await new Promise(setImmediate);

    expect(findTransaction).not.toHaveBeenCalled();
  });

  it('searches once at mortality and expires an absent transaction', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, txResult } = createBidRecoveryHarness(accountset);
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    const previousHeader = createBlockHeader(deathBlock - 1, `0x${'07'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: previousHeader });
    blockWatch.events.emit('best-blocks', [previousHeader]);
    await new Promise(setImmediate);
    expect(findTransaction).not.toHaveBeenCalled();

    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);
    blockWatch.events.emit('best-blocks', [deathHeader]);

    await expect(txResult.waitForInFirstBlock).rejects.toThrow('Bid transaction expired before block inclusion');
    await expect(txResult.waitForFinalizedBlock).rejects.toThrow('Bid transaction expired before block inclusion');
    expect(findTransaction).toHaveBeenCalledTimes(1);
  });

  it('finalizes a silently included transaction recovered at mortality', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, getFinalizedHash, includedBlock, txResult } =
      createBidRecoveryHarness(accountset);
    const findTransaction = vi
      .spyOn(TransactionEvents, 'findByExtrinsicHash')
      .mockResolvedValue(createFoundTransaction(includedBlock));

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);

    await expect(txResult.waitForInFirstBlock).resolves.toHaveLength(32);
    expect(findTransaction).toHaveBeenCalledTimes(1);
    await new Promise(setImmediate);

    const finalizedHeader = { ...includedBlock, isFinalized: true };
    Object.assign(blockWatch, { finalizedBlockHeader: finalizedHeader });
    blockWatch.events.emit('finalized', [finalizedHeader]);

    await expect(txResult.waitForFinalizedBlock).resolves.toHaveLength(32);
    expect(getFinalizedHash).toHaveBeenCalledWith(includedBlock.blockNumber);

    await new Promise(setImmediate);
    blockWatch.events.emit('best-blocks', [deathHeader]);
    blockWatch.events.emit('finalized', [finalizedHeader]);
    await new Promise(setImmediate);
    expect(findTransaction).toHaveBeenCalledTimes(1);
    expect(getFinalizedHash).toHaveBeenCalledTimes(1);
  });

  it('finalizes when transaction tracking stops after reporting inclusion', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, includedBlock, txResult } = createBidRecoveryHarness(accountset);
    const found = createFoundTransaction(includedBlock);
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(found);

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    await txResult.setSeenInBlock(accountset.client, {
      blockHash: Uint8Array.from({ length: 32 }, () => 1),
      blockNumber: found.blockNumber,
      events: found.extrinsicEvents,
      extrinsicIndex: found.extrinsicIndex,
    });

    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);
    await new Promise(setImmediate);

    const finalizedHeader = { ...includedBlock, isFinalized: true };
    Object.assign(blockWatch, { finalizedBlockHeader: finalizedHeader });
    blockWatch.events.emit('finalized', [finalizedHeader]);

    await expect(txResult.waitForFinalizedBlock).resolves.toHaveLength(32);
    expect(findTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a recovered transaction reorged before finalization', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, getFinalizedHash, includedBlock, txResult } =
      createBidRecoveryHarness(accountset);
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(createFoundTransaction(includedBlock));
    getFinalizedHash.mockResolvedValue(`0x${'02'.repeat(32)}`);

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);

    await expect(txResult.waitForInFirstBlock).resolves.toHaveLength(32);
    await new Promise(setImmediate);

    const finalizedHeader = { ...includedBlock, isFinalized: true };
    Object.assign(blockWatch, { finalizedBlockHeader: finalizedHeader });
    blockWatch.events.emit('finalized', [finalizedHeader]);

    await expect(txResult.waitForFinalizedBlock).rejects.toThrow(
      'Recovered bid transaction was reorged before finalization',
    );
  });

  it('reports an actionable error when mortality lookup remains unavailable', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, txResult } = createBidRecoveryHarness(accountset);
    const findTransaction = vi
      .spyOn(TransactionEvents, 'findByExtrinsicHash')
      .mockRejectedValue(new Error('temporary rpc failure'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // @ts-expect-error exercise the real bidder receipt tracking boundary
    void cohortBidder.trackReceipt(txResult, deathBlock);
    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    vi.useFakeTimers();
    try {
      blockWatch.events.emit('best-blocks', [deathHeader]);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    await expect(txResult.waitForInFirstBlock).rejects.toThrow('Bid inclusion could not be verified');
    await expect(txResult.waitForFinalizedBlock).rejects.toThrow('Bid inclusion could not be verified');
    expect(findTransaction).toHaveBeenCalledTimes(5);
  });

  it('waits for an in-flight bid submission during shutdown', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      accountBalance: Argons(10),
    });
    let resolveSubmission!: () => void;
    const pendingSubmission = new Promise<void>(resolve => {
      resolveSubmission = resolve;
    });
    // @ts-expect-error reproducing the submission lifecycle
    cohortBidder.pendingRequest = pendingSubmission;

    let stopped = false;
    const stopPromise = cohortBidder.stop(false).then(() => {
      stopped = true;
    });
    await new Promise(setImmediate);

    expect(stopped).toBe(false);

    resolveSubmission();
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it('waits for pending bid mortality at cohort shutdown', async () => {
    const finalizedHeader = {
      ...createBlockHeader(105, `0x${'05'.repeat(32)}`),
      isFinalized: true,
      frameId: 10,
    };
    const events = createTypedEventEmitter();
    const stopApi = {
      query: {
        miningSlot: {
          minersByCohort: vi.fn().mockResolvedValue([]),
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(10),
        },
        system: { number: vi.fn().mockResolvedValue(finalizedHeader.blockNumber) },
        ticks: { currentTick: vi.fn().mockResolvedValue(finalizedHeader.tick) },
      },
    };
    const mortalEra = { asMortalEra: { birth: () => 92, death: () => 108 } };
    const client = {
      at: vi.fn().mockResolvedValue(stopApi),
      query: stopApi.query,
      consts: { system: { blockHashCount: 4096 } },
      registry: { createType: vi.fn().mockReturnValue(mortalEra) },
      rpc: {
        chain: { getFinalizedHead: vi.fn().mockResolvedValue(finalizedHeader.blockHash) },
        system: { accountNextIndex: vi.fn().mockResolvedValue(0) },
      },
    };
    const blockWatch = {
      bestBlockHeader: { ...createBlockHeader(100, `0x${'00'.repeat(32)}`), frameRewardTicksRemaining: 10 },
      finalizedBlockHeader: { ...createBlockHeader(99, `0x${'00'.repeat(32)}`), isFinalized: true },
      latestHeaders: [finalizedHeader],
      events,
      subscriptionClient: client,
      getFinalizedHash: vi.fn().mockResolvedValue(finalizedHeader.blockHash),
    } as unknown as BlockWatch;
    const cohortBidder = new CohortBidder(
      accountset,
      { blockWatch } as MiningFrames,
      10,
      accountset.getAccountsInRange([0]).map(account => ({
        address: account.address,
        isRebid: false,
        index: account.index,
      })),
      {
        minBid: 500_000n,
        maxBid: 1_000_000n,
        bidIncrement: 10_000n,
        bidDelay: 1,
      },
    );
    cohortBidder.nextBid = {
      microgonsPerSeat: 500_000n,
      subaccounts: [cohortBidder.subaccounts[0].address],
      alreadyWinningSeats: 0,
      bidAtTick: finalizedHeader.tick,
      tip: 0n,
    };

    const txResult = new TxResult({
      signedHash: `0x${'ff'.repeat(32)}`,
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: 100,
      accountAddress: accountset.txSubmitterPair.address,
      nonce: 0,
    });
    const signedTx = {
      era: mortalEra,
      nonce: { toNumber: () => 0 },
    };
    const submitter = new TxSubmitter(
      client as unknown as ArgonClient,
      { signAsync: vi.fn().mockResolvedValue(signedTx) } as never,
      accountset.txSubmitterPair,
    );
    vi.spyOn(submitter, 'submitSigned').mockResolvedValue(txResult);
    vi.spyOn(accountset, 'createMiningBidTx').mockResolvedValue(submitter);
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);

    // @ts-expect-error exercising the private submission flow
    const pendingRequest = cohortBidder.submitNextBid();
    // @ts-expect-error reproducing the onHeader pending request lifecycle
    cohortBidder.pendingRequest = pendingRequest;

    const stopPromise = cohortBidder.stop(true);
    await new Promise(setImmediate);
    const deathHeader = createBlockHeader(108, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);
    blockWatch.events.emit('finalized', [{ ...deathHeader, frameId: 10, isFinalized: true }]);
    const outcome = await Promise.race([
      stopPromise.then(() => 'stopped'),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    if (outcome === 'timed-out') {
      txResult.submissionError = new Error('test cleanup');
      await stopPromise;
    }

    expect(outcome).toBe('stopped');
    expect(txResult.submissionError?.message).toBe('Bid transaction expired before block inclusion');
    // @ts-expect-error verifying private lifecycle cleanup
    expect(cohortBidder.pendingFinalizations.size).toBe(0);
  });
});

function Argons(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

function createBids(count: number, bidMicrogons: bigint, atTick: number = 100) {
  return Array(count)
    .fill(0)
    .map((_, i) => {
      return { bidAtTick: atTick, bidMicrogons: bidMicrogons, address: `5EANERnc__${i}`, micronotsStaked: 10_000n };
    });
}

async function createBidderWithMocks(
  accountset: Accountset,
  subaccountRange: [number, number],
  options: Partial<ICohortBidderOptions> & { accountBalance: bigint; accountMicronots?: bigint },
) {
  const range = Array.from({ length: subaccountRange[1] - subaccountRange[0] + 1 }, (_, i) => i + subaccountRange[0]);
  const subaccounts = accountset.getAccountsInRange(range).map(account => {
    return {
      address: account.address,
      isRebid: false,
      index: account.index,
    };
  });
  options.maxBid ??= 1_000_000n;
  options.minBid ??= 500_000n;
  options.bidIncrement ??= 10_000n;
  options.bidDelay ??= 1;

  const cohortBidder = new CohortBidder(accountset, null as any, 10, subaccounts, options as ICohortBidderOptions);
  // @ts-expect-error - private var
  cohortBidder.nextCohortSize = 10;
  // @ts-expect-error - private var
  cohortBidder.micronotsPerSeat = 10_000n;
  vi.spyOn(cohortBidder, 'estimateFee' as any).mockImplementation(() => {
    return 60_000n;
  });
  vi.spyOn(accountset, 'balance').mockImplementation(() => {
    return Promise.resolve(options.accountBalance);
  });
  vi.spyOn(accountset, 'accountMicronots').mockImplementation(() => {
    return Promise.resolve(options.accountMicronots ?? 100_000n);
  });

  const submitBids = vi.fn().mockImplementation(() => Promise.resolve());
  // @ts-expect-error - private var
  cohortBidder.submitBids = submitBids;
  return { cohortBidder, submitBids };
}

async function createBidLifecycleHarness(accountset: Accountset) {
  const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
    minBid: 500_000n,
    maxBid: 1_000_000n,
    bidDelay: 100,
    accountBalance: 10_000_000n,
  });
  const registry = getOfflineRegistry();
  const canonicalHashes = new Map<number, string>();
  let poolNonce = 0;
  let biddingOpen = true;
  const client = {
    registry,
    canonicalHashes,
    consts: { system: { blockHashCount: 4096 } },
    rpc: {
      chain: { getBlockHash: async (height: number) => ({ toHex: () => canonicalHashes.get(height) }) },
      state: { getStorageHash: async () => ({ toHex: () => '0xunchanged' }) },
      system: { accountNextIndex: async () => poolNonce },
    },
    query: {
      system: { account: async () => ({ nonce: 0 }) },
      miningSlot: { isNextSlotBiddingOpen: async () => biddingOpen, nextFrameId: async () => 10 },
      ticks: { currentTick: async () => 102 },
    },
    at: async () => client,
    api: undefined as unknown as ArgonClient,
  };
  client.api = client as unknown as ArgonClient;
  const blockWatch = {
    bestBlockHeader: createBlockHeader(100, `0x${'01'.repeat(32)}`),
    finalizedBlockHeader: { ...createBlockHeader(96, `0x${'02'.repeat(32)}`), isFinalized: true },
    getFinalizedHash: async () => `0x${'03'.repeat(32)}`,
    getHeader: async ({ blockNumber, blockHash }: { blockNumber: number; blockHash: string }) =>
      createBlockHeader(blockNumber, blockHash),
    getEvents: async () => [],
    latestHeaders: [],
    events: createTypedEventEmitter(),
    subscriptionClient: client.api,
  } as unknown as BlockWatch;
  cohortBidder.miningFrames = { blockWatch } as MiningFrames;

  const results: TxResult[] = [];
  const sign = vi.fn(async (_signer: unknown, options: NonNullable<Parameters<TxSubmitter['sign']>[0]>) => {
    return {
      era: options.era,
      nonce: { toNumber: () => (typeof options.nonce === 'number' ? options.nonce : poolNonce) },
    };
  });
  const submitSigned = vi.fn(async (signedTx: Awaited<ReturnType<typeof sign>>) => {
    const result = new TxResult({
      signedHash: `0x${(results.length + 1).toString(16).padStart(64, '0')}`,
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: blockWatch.bestBlockHeader.blockNumber,
      accountAddress: accountset.txSubmitterPair.address,
      nonce: signedTx.nonce.toNumber(),
    });
    results.push(result);
    return result;
  });
  const submitter = new TxSubmitter(client.api, { signAsync: sign } as never, accountset.txSubmitterPair);
  vi.spyOn(submitter, 'submitSigned').mockImplementation(submitSigned as never);
  vi.spyOn(accountset, 'createMiningBidTx').mockResolvedValue(submitter);

  return {
    cohortBidder,
    blockWatch,
    client,
    results,
    sign,
    submitSigned,
    setPoolNonce: (nonce: number) => (poolNonce = nonce),
    setBiddingOpen: (open: boolean) => (biddingOpen = open),
  };
}

function createBidRecoveryHarness(accountset: Accountset, args: { latestBlockNumber?: number } = {}) {
  const submittedBlock = createBlockHeader(100, `0x${'00'.repeat(32)}`);
  const includedBlock = createBlockHeader(101, `0x${'01'.repeat(32)}`);
  const latestBlock = args.latestBlockNumber === includedBlock.blockNumber ? includedBlock : submittedBlock;
  const events = createTypedEventEmitter();
  const getFinalizedHash = vi.fn(async (blockNumber: number) => {
    return blockNumber === includedBlock.blockNumber ? includedBlock.blockHash : submittedBlock.blockHash;
  });
  const blockWatch = {
    bestBlockHeader: latestBlock,
    finalizedBlockHeader: submittedBlock,
    latestHeaders: [latestBlock],
    events,
    getFinalizedHash,
  } as unknown as BlockWatch;
  const cohortBidder = new CohortBidder(
    accountset,
    { blockWatch } as MiningFrames,
    10,
    accountset.getAccountsInRange([0]).map(account => ({
      address: account.address,
      isRebid: false,
      index: account.index,
    })),
    {
      minBid: 500_000n,
      maxBid: 1_000_000n,
      bidIncrement: 10_000n,
      bidDelay: 1,
    },
  );
  const txResult = new TxResult({
    signedHash: `0x${'ff'.repeat(32)}`,
    method: {},
    submittedTime: new Date(),
    submittedAtBlockNumber: submittedBlock.blockNumber,
    accountAddress: accountset.txSubmitterPair.address,
    nonce: 0,
  });

  return { blockWatch, cohortBidder, getFinalizedHash, includedBlock, txResult };
}

function createBlockHeader(blockNumber: number, blockHash: string): IBlockHeaderInfo {
  return {
    isFinalized: false,
    blockNumber,
    blockHash,
    blockTime: blockNumber * 60_000,
    parentHash: `0x${'00'.repeat(32)}`,
    author: '',
    tick: blockNumber,
    frameId: 9,
    frameRewardTicksRemaining: 20,
  };
}

function createFoundTransaction(block: IBlockHeaderInfo) {
  return {
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    blockTime: block.blockTime,
    extrinsicIndex: 0,
    fee: 1n,
    tip: 0n,
    extrinsicEvents: [],
  };
}
