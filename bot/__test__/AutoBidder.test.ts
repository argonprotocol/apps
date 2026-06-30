import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoBidder } from '../src/AutoBidder.ts';

describe('AutoBidder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('holds off bidding until the mining bid proxy is ready', async () => {
    vi.useFakeTimers();

    const autoBidder = new AutoBidder(
      {
        planMiningBidProxySetup: vi.fn().mockResolvedValue({ kind: 'tx' }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const createBidderParams = vi.spyOn(autoBidder as any, 'createBidderParams');
    const reloadActiveCohort = vi.spyOn(autoBidder as any, 'reloadActiveCohort').mockResolvedValue(undefined);

    await (autoBidder as any).onBiddingStart(12);

    expect(createBidderParams).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).toHaveBeenCalledOnce();
  });
});
