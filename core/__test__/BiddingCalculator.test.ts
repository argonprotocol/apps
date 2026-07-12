import { describe, expect, it, vi } from 'vitest';
import BiddingCalculator from '../src/BiddingCalculator.ts';

describe('BiddingCalculator loading', () => {
  it('allows a later load to retry after a frame load failure', async () => {
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    const onFrameId = vi.fn((callback: (frameId: number) => Promise<void> | void) => {
      void callback(1);
      return { unsubscribe: onFrameId.mock.calls.length === 1 ? unsubscribeFirst : unsubscribeSecond };
    });
    const calculator = new BiddingCalculator(
      {
        load,
        miningFrames: {
          load: vi.fn().mockResolvedValue(undefined),
          onFrameId,
        },
      } as any,
      {} as any,
    );
    vi.spyOn(calculator, 'calculateBidAmounts').mockImplementation(() => undefined);

    await expect(calculator.load()).rejects.toBe(error);
    await expect(calculator.load()).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledTimes(2);
    expect(onFrameId).toHaveBeenCalledTimes(2);
    expect(unsubscribeFirst).toHaveBeenCalledOnce();
  });
});
