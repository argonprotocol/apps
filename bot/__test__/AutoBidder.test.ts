import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
