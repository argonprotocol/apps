import { afterEach, describe, expect, it, vi } from 'vitest';
import { CohortBidder, createTypedEventEmitter } from '@argonprotocol/apps-core';
import { AutoBidder } from '../src/AutoBidder.ts';
import { History } from '../src/History.ts';

const onBiddingStart = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'onBiddingStart')!.value as (
  this: AutoBidder,
  cohortActivationFrameId: number,
) => Promise<void>;
const onBiddingEnd = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'onBiddingEnd')!.value as (
  this: AutoBidder,
  cohortActivationFrameId: number,
  waitForFinalBids?: boolean,
) => Promise<void>;

describe('AutoBidder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes empty capacity for the current auction while the mining bid proxy is unavailable', async () => {
    vi.useFakeTimers();

    const history = new History({} as any, 11);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argonot-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValue({ kind: 'tx' }),
      } as any,
      {} as any,
      {} as any,
      history,
      {} as any,
      {} as any,
    );
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);
    const createBidderParams = vi.fn();
    const reloadActiveCohort = vi.fn().mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(createBidderParams).not.toHaveBeenCalled();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).toHaveBeenCalledOnce();
  });

  it('clears a pending proxy retry once bidding can start', async () => {
    vi.useFakeTimers();

    const initCohort = vi.fn();
    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValueOnce({ kind: 'tx' }).mockResolvedValueOnce({ kind: 'ready' }),
      } as any,
      {} as any,
      {} as any,
      { initCohort } as any,
      {} as any,
      {} as any,
    );
    const reloadActiveCohort = vi.fn().mockResolvedValue(undefined);
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 0n,
      maxBid: 0n,
      maxSeats: 0,
      bidDelay: 0,
      bidIncrement: 1n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await onBiddingStart.call(autoBidder, 12);
    await onBiddingStart.call(autoBidder, 12);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12);
  });

  it('starts bidding without checking proxy setup', async () => {
    const planMiningBidProxySetup = vi.fn();
    const history = new History({} as any, 11);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        planMiningBidProxySetup,
      } as any,
      {} as any,
      {} as any,
      history,
      {} as any,
      {} as any,
    );
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 0n,
      maxBid: 0n,
      maxSeats: 0,
      bidDelay: 0,
      bidIncrement: 1n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    Object.assign(autoBidder, {
      createBidderParams,
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(planMiningBidProxySetup).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12);
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('retries a failed bidder start while the auction remains open', async () => {
    vi.useFakeTimers();

    const client = {
      query: {
        miningSlot: {
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(12),
        },
      },
    };
    const history = new History({} as any, 11);
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        txSubmitterPair: { address: '5FundingAccount' },
        getAvailableMinerAccounts: vi.fn().mockResolvedValue([{ index: 0, isRebid: false, address: '5MiningAccount' }]),
      } as any,
      {
        prunedClientOrArchivePromise: Promise.resolve(client),
      } as any,
      {
        bidsFile: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(undefined) }),
      } as any,
      history,
      {} as any,
      {} as any,
    );
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 100_000n,
      maxBid: 1_000_000n,
      maxSeats: 1,
      bidDelay: 1,
      bidIncrement: 10_000n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    const startBidder = vi
      .spyOn(CohortBidder.prototype, 'start')
      .mockRejectedValueOnce(new Error('temporary RPC failure'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(CohortBidder.prototype, 'stop').mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams,
    });
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);

    await onBiddingStart.call(autoBidder, 12);

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await (autoBidder as any).lifecycleQueue;

    expect(startBidder).toHaveBeenCalledTimes(2);
    expect(autoBidder.currentBidder?.cohortStartingFrameId).toBe(12);
  });

  it('clears the completed auction capacity when bidding ends', async () => {
    const history = new History({} as any, 12);
    history.maxSeatsInPlay = 4;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder({} as any, {} as any, {} as any, history, {} as any, {} as any);
    const bidder = {
      isBiddingOpen: true,
      stop: vi.fn().mockResolvedValue([]),
    };
    Object.assign(autoBidder, {
      nextCohortActivationFrameId: 12,
      cohortBiddersByActivationFrameId: new Map([[12, bidder]]),
    });
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);

    await onBiddingEnd.call(autoBidder, 12, false);

    expect(bidder.stop).toHaveBeenCalledWith(false);
    expect(autoBidder.currentBidder).toBeUndefined();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('reconciles a stale bidder when a new frame arrives without a cohort notification', async () => {
    const client = {
      queryMulti: vi.fn().mockResolvedValue(() => undefined),
      query: {
        miningSlot: {
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(539),
        },
      },
    };
    const miningFrames = {
      events: createTypedEventEmitter<{
        'on-frame': (frame: { frameId: number; blockNumber: number; blockHash: string }) => void;
      }>(),
    };
    const history = new History({} as any, 537);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        registerKeys: vi.fn(),
      } as any,
      {
        prunedClientOrArchivePromise: Promise.resolve(client),
      } as any,
      {} as any,
      history,
      {} as any,
      miningFrames as any,
    );
    const staleBidder = {
      isBiddingOpen: true,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createBidderParams = vi.fn().mockResolvedValue({ maxSeats: 0 });
    Object.assign(autoBidder, {
      biddingCalculator: {
        load: vi.fn(),
        unload: vi.fn(),
      },
      cohortBiddersByActivationFrameId: new Map([[537, staleBidder]]),
      nextCohortActivationFrameId: 537,
      createBidderParams,
    });

    await autoBidder.start('ws://argon-miner:9944');

    miningFrames.events.emit('on-frame', {
      frameId: 538,
      blockNumber: 876_000,
      blockHash: '0xframe538',
    });
    await (autoBidder as any).lifecycleQueue;

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(staleBidder.stop).toHaveBeenCalledOnce();
    expect(createBidderParams).toHaveBeenCalledWith(539);
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
  });
});
