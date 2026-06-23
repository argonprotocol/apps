import { describe, expect, it, vi } from 'vitest';
import { raceWithTimeout } from '../src/utils.ts';

describe('raceWithTimeout', () => {
  it('returns the original promise result when it resolves before the timeout', async () => {
    await expect(raceWithTimeout(Promise.resolve('ready'), 100, () => 'timed-out')).resolves.toBe('ready');
  });

  it('returns the timeout result when the promise does not settle in time', async () => {
    vi.useFakeTimers();

    const resultPromise = raceWithTimeout(new Promise<string>(() => undefined), 100, () => 'timed-out');
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toBe('timed-out');
    vi.useRealTimers();
  });

  it('rejects when the original promise rejects before the timeout', async () => {
    await expect(raceWithTimeout(Promise.reject(new Error('boom')), 100, () => 'timed-out')).rejects.toThrow('boom');
  });
});
