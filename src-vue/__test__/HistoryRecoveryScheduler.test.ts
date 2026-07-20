import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinalizedHistoryScheduler } from '../lib/recovery/Scheduler.ts';

describe('FinalizedHistoryScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not make a newer target wait for retry backoff', async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<(target: number) => Promise<number>>()
      .mockRejectedValueOnce(new Error('indexer unavailable'))
      .mockImplementation(async target => target);
    const scheduler = new FinalizedHistoryScheduler(refresh, 10);

    scheduler.queue(12);
    await vi.advanceTimersByTimeAsync(10);
    scheduler.queue(13);
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenNthCalledWith(1, 12, false);
    expect(refresh).toHaveBeenNthCalledWith(2, 13, false);
    expect(scheduler.processedThroughBlock).toBe(13);
    await scheduler.close();
  });

  it('does not retry a history integrity mismatch', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error('Wallet history index hash mismatch at block 12'));
    const scheduler = new FinalizedHistoryScheduler(refresh, 10);

    scheduler.queue(12);
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh).toHaveBeenCalledOnce();
    await scheduler.close();
  });

  it('keeps retrying an unavailable source with capped backoff', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error('indexer unavailable'));
    const scheduler = new FinalizedHistoryScheduler(refresh, 10);

    scheduler.queue(12);
    await vi.advanceTimersByTimeAsync(120);

    expect(refresh).toHaveBeenCalledTimes(5);
    await scheduler.close();
  });
});
