import {
  Accountset,
  type BlockWatch,
  CohortBidder,
  getRange,
  type ICohortBidderOptions,
  type IBlockHeaderInfo,
  type MiningFrames,
  TransactionEvents,
} from '../src/index.ts';
import { sudo } from '@argonprotocol/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ArgonClient, mnemonicGenerate, TxResult } from '@argonprotocol/mainchain';
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
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
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

  it('should be not exceed available argonots', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 30_000n,
      sidelinedWalletMicronots: 10_000n, // max of 2 seats worth
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

  it('should be able to set a max argonot budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 100_000n, // max of 2 seats worth
    });
    cohortBidder.options.sidelinedWalletMicronots = 90_000n; // max 1 more
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

  it('does not wait for storage freshness after a bid transaction has no successful calls', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 0], {
      minBid: 500_000n,
      maxBid: 1_000_000n,
      accountBalance: 1_000_000n,
    });
    cohortBidder.currentBids.atTick = 100;
    cohortBidder.lastBid = {
      submittedAtTick: 100,
      expectedFinalizationTick: 105,
      isFinalized: true,
      microgonsPerSeat: 500_000n,
      seats: 1,
      seatsWon: 0,
    };

    // @ts-expect-error exercising the private planning flow
    await cohortBidder.planNextBid();

    expect(cohortBidder.nextBid?.subaccounts).toHaveLength(1);
  });

  it('counts a failed bid finalization as zero successful bids', async () => {
    const currentTick = 100;
    const bidError = new Error('proxy rejected the batch');
    const client = {
      at: vi.fn(),
      query: {
        ticks: {
          currentTick: vi.fn().mockResolvedValue({ toNumber: () => currentTick }),
        },
      },
    };
    client.at.mockResolvedValue(client);
    const blockWatch = {
      bestBlockHeader: createBlockHeader(100, `0x${'01'.repeat(32)}`),
      subscriptionClient: client,
    };
    const onBidsRejected = vi.fn();
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
      { onBidsRejected },
    );
    cohortBidder.lastBid = {
      submittedAtTick: currentTick,
      expectedFinalizationTick: currentTick + 5,
      isFinalized: false,
      microgonsPerSeat: 500_000n,
      seats: 1,
      seatsWon: 1,
    };
    const txResult = {
      blockHash: new Uint8Array([1]),
      blockNumber: 100,
      submissionError: bidError,
      finalFee: 0n,
      waitForFinalizedBlock: Promise.reject(bidError),
    } as TxResult;

    // @ts-expect-error exercising the private finalization flow
    await cohortBidder.awaitFinalization(txResult, 500_000n, 1);

    expect(cohortBidder.lastBid.seatsWon).toBe(0);
    expect(onBidsRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        submittedCount: 1,
        rejectedCount: 1,
      }),
    );
  });

  it('does not let an older finalization overwrite a newer bid record', async () => {
    const currentTick = 100;
    const client = {
      at: vi.fn(),
      query: {
        ticks: {
          currentTick: vi.fn().mockResolvedValue({ toNumber: () => currentTick }),
        },
      },
    };
    client.at.mockResolvedValue(client);
    const blockWatch = {
      bestBlockHeader: createBlockHeader(100, `0x${'01'.repeat(32)}`),
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
    let finalizeOlderBid!: (blockHash: Uint8Array) => void;
    const txResult = {
      blockHash: new Uint8Array([1]),
      blockNumber: 100,
      finalFee: 0n,
      waitForFinalizedBlock: new Promise(resolve => {
        finalizeOlderBid = resolve;
      }),
    } as TxResult;
    const olderBid = {
      submittedAtTick: currentTick,
      expectedFinalizationTick: currentTick + 5,
      isFinalized: false,
      microgonsPerSeat: 500_000n,
      seats: 1,
      seatsWon: 1,
    };
    cohortBidder.lastBid = olderBid;

    // @ts-expect-error exercising the private finalization flow
    const olderFinalization = cohortBidder.awaitFinalization(txResult, 500_000n, 1);
    await new Promise(setImmediate);

    cohortBidder.lastBid = {
      submittedAtTick: currentTick + 1,
      expectedFinalizationTick: currentTick + 6,
      isFinalized: false,
      microgonsPerSeat: 600_000n,
      seats: 1,
      seatsWon: 1,
    };
    finalizeOlderBid(new Uint8Array([1]));
    await olderFinalization;

    expect(olderBid.isFinalized).toBe(true);
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
    vi.spyOn(accountset, 'submitterBalance')
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
    vi.spyOn(accountset, 'submitterBalance').mockImplementation(() => Promise.resolve(accountBalance));
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
            data: [{ toString: () => accountset.fundingAccountId }],
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

  it('claims a planned bid before asynchronous transaction creation begins', async () => {
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
    let rejectCreation!: (error: Error) => void;
    vi.spyOn(accountset, 'createMiningBidTx').mockReturnValue(
      new Promise((_, reject) => {
        rejectCreation = reject;
      }),
    );
    vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);

    // @ts-expect-error exercising the private submission flow
    const pendingRequest = cohortBidder.submitNextBid();
    await new Promise(setImmediate);

    expect(cohortBidder.nextBid).toBeUndefined();

    rejectCreation(new Error('test cleanup'));
    await pendingRequest;
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
    { frameRewardTicksRemaining: 10, expectedEra: 8 },
    { frameRewardTicksRemaining: 8, expectedEra: 4 },
    { frameRewardTicksRemaining: 7, expectedEra: 4 },
    { frameRewardTicksRemaining: 5, expectedEra: 4 },
    { frameRewardTicksRemaining: 4, expectedEra: 4 },
    { frameRewardTicksRemaining: 1, expectedEra: 4 },
  ])(
    'selects safe bid mortality when $frameRewardTicksRemaining frame ticks remain',
    async ({ frameRewardTicksRemaining, expectedEra }) => {
      const currentTick = 100;
      const bestBlockHash = `0x${'01'.repeat(32)}`;
      const death = vi.fn().mockReturnValue(100 + expectedEra);
      const mortalEra = { asMortalEra: { death } };
      const client = {
        at: vi.fn(),
        registry: {
          createType: vi.fn().mockReturnValue(mortalEra),
        },
        query: {
          ticks: {
            currentTick: vi.fn().mockResolvedValue({ toNumber: () => currentTick }),
          },
        },
      };
      client.at.mockResolvedValue(client);
      const blockWatch = {
        bestBlockHeader: { blockNumber: 100, blockHash: bestBlockHash, frameRewardTicksRemaining },
        finalizedBlockHeader: { blockNumber: 99, blockHash: '0xfinalized' },
        latestHeaders: [],
        events: createTypedEventEmitter(),
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
      cohortBidder.nextBid = {
        microgonsPerSeat: 500_000n,
        subaccounts: [cohortBidder.subaccounts[0].address],
        alreadyWinningSeats: 0,
        bidAtTick: currentTick,
        tip: 0n,
      };

      const txResult = {
        extrinsic: { submittedAtBlockNumber: 100 },
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
        waitForFinalizedBlock: Promise.resolve(new Uint8Array([1])),
        isFinalized: true,
        blockHash: new Uint8Array([1]),
        blockNumber: 100,
      } as TxResult;
      const signedTx = { era: mortalEra };
      const sign = vi.fn().mockResolvedValue(signedTx);
      const submitSigned = vi.fn().mockResolvedValue(txResult);
      vi.spyOn(accountset, 'createMiningBidTx').mockResolvedValue({
        client,
        sign,
        submitSigned,
      } as never);
      vi.spyOn(cohortBidder, 'planNextBid' as any).mockResolvedValue(undefined);

      // @ts-expect-error exercising the private submission flow
      await cohortBidder.submitNextBid();

      expect(client.registry.createType).toHaveBeenCalledWith('ExtrinsicEra', {
        current: 100,
        period: expectedEra,
      });
      expect(sign).toHaveBeenCalledWith({
        blockHash: bestBlockHash,
        era: mortalEra,
        tip: 0n,
        useLatestNonce: true,
      });
      expect(submitSigned).toHaveBeenCalledWith(signedTx);
      expect(death).toHaveBeenCalledWith(100);
      expect(cohortBidder.lastBid?.submittedAtTick).toBe(currentTick);
    },
  );

  it('does not search when transaction tracking reports finalization normally', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, includedBlock, txResult } = createBidRecoveryHarness(accountset);
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash');

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
    const found = createFoundTransaction(includedBlock);
    await txResult.setSeenInBlock({
      blockHash: Uint8Array.from({ length: 32 }, () => 1),
      blockNumber: found.blockNumber,
      events: found.extrinsicEvents,
      extrinsicIndex: found.extrinsicIndex,
    });
    await txResult.setFinalized();

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

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
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

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
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
  });

  it('finalizes when transaction tracking stops after reporting inclusion', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, includedBlock, txResult } = createBidRecoveryHarness(accountset);
    const found = createFoundTransaction(includedBlock);
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(found);

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
    await txResult.setSeenInBlock({
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

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
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

  it('rejects a silent transaction when its mortality lookup fails', async () => {
    const deathBlock = 108;
    const { blockWatch, cohortBidder, txResult } = createBidRecoveryHarness(accountset);
    const lookupError = new Error('temporary rpc failure');
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockRejectedValue(lookupError);
    vi.spyOn(cohortBidder, 'error' as any).mockImplementation(() => undefined);

    // @ts-expect-error exercising private mortality fallback behavior
    cohortBidder.startBidMortalityFallback(txResult, deathBlock);
    const deathHeader = createBlockHeader(deathBlock, `0x${'08'.repeat(32)}`);
    Object.assign(blockWatch, { bestBlockHeader: deathHeader });
    blockWatch.events.emit('best-blocks', [deathHeader]);

    await expect(txResult.waitForInFirstBlock).rejects.toThrow(lookupError.message);
    await expect(txResult.waitForFinalizedBlock).rejects.toThrow(lookupError.message);
    expect(findTransaction).toHaveBeenCalledTimes(1);
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
        miningSlot: { minersByCohort: vi.fn().mockResolvedValue([]) },
        system: { number: vi.fn().mockResolvedValue({ toNumber: () => finalizedHeader.blockNumber }) },
        ticks: { currentTick: vi.fn().mockResolvedValue({ toNumber: () => finalizedHeader.tick }) },
      },
    };
    const mortalEra = { asMortalEra: { death: () => 108 } };
    const client = {
      at: vi.fn().mockResolvedValue(stopApi),
      query: stopApi.query,
      registry: { createType: vi.fn().mockReturnValue(mortalEra) },
      rpc: {
        chain: { getFinalizedHead: vi.fn().mockResolvedValue(finalizedHeader.blockHash) },
        system: { accountNextIndex: vi.fn().mockResolvedValue(0) },
      },
    };
    const blockWatch = {
      bestBlockHeader: finalizedHeader,
      finalizedBlockHeader: finalizedHeader,
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

    const txResult = new TxResult({} as ArgonClient, {
      signedHash: `0x${'ff'.repeat(32)}`,
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: 100,
      accountAddress: accountset.txSubmitterPair.address,
      nonce: 0,
    });
    const signedTx = {
      era: mortalEra,
    };
    const sign = vi.fn().mockResolvedValue(signedTx);
    const submitSigned = vi.fn().mockResolvedValue(txResult);
    vi.spyOn(accountset, 'createMiningBidTx').mockResolvedValue({
      client,
      sign,
      submitSigned,
    } as never);
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
  vi.spyOn(accountset, 'submitterBalance').mockImplementation(() => {
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
  const txResult = new TxResult({} as ArgonClient, {
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
