import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTypedEventEmitter } from '@argonprotocol/apps-core';
import { AutoBidder } from '../src/AutoBidder.ts';

const onBiddingStart = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'onBiddingStart')!.value as (
  this: AutoBidder,
  cohortActivationFrameId: number,
) => Promise<void>;

describe('AutoBidder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('holds off bidding until the mining bid proxy is ready', async () => {
    vi.useFakeTimers();

    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValue({ kind: 'tx' }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const createBidderParams = vi.fn();
    const reloadActiveCohort = vi.fn().mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(createBidderParams).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).toHaveBeenCalledOnce();
  });

  it('clears a pending proxy retry once bidding can start', async () => {
    vi.useFakeTimers();

    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValueOnce({ kind: 'tx' }).mockResolvedValueOnce({ kind: 'ready' }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
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
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        planMiningBidProxySetup,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
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
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        registerKeys: vi.fn(),
      } as any,
      {
        prunedClientOrArchivePromise: Promise.resolve(client),
      } as any,
      {} as any,
      {} as any,
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
  });
});
