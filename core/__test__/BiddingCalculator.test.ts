import { describe, expect, it, vi } from 'vitest';
import BiddingCalculator from '../src/BiddingCalculator.ts';

describe('BiddingCalculator loading', () => {
  it('keeps the frame subscription after a later frame load failure', async () => {
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const load = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const unsubscribe = vi.fn();
    let onFrame: (frameId: number) => Promise<void> | void = () => undefined;
    const onFrameId = vi.fn((callback: typeof onFrame) => {
      onFrame = callback;
      void callback(1);
      return { unsubscribe };
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
    const calculateBidAmounts = vi.spyOn(calculator, 'calculateBidAmounts').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await calculator.load();
    await onFrame(2);
    await onFrame(3);

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(3);
    expect(calculateBidAmounts).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('Error loading bidding calculator frame', error);

    consoleError.mockRestore();
  });

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
