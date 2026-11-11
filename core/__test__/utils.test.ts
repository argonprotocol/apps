import { describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { JsonExt } from '../src/JsonExt.ts';
import { bigNumberToBigInt, raceWithTimeout } from '../src/utils.ts';

it.each([
  ['0.1', 0n, 1n],
  ['-2.1', -2n, -2n],
  ['1000000000000000000000000.1', 1000000000000000000000000n, 1000000000000000000000001n],
])('converts %s to bigint with truncation or rounding up', (value, truncated, roundedUp) => {
  expect(bigNumberToBigInt(BigNumber(value))).toBe(truncated);
  expect(bigNumberToBigInt(BigNumber(value), true)).toBe(roundedUp);
});

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

describe('JsonExt', () => {
  it('sorts object fields for stable files while preserving native values and array order', () => {
    const source = {
      z: [2n, 1n],
      a: {
        rate: new BigNumber('0.0000000000000000003'),
        date: new Date('2026-01-01T00:00:00.000Z'),
        bytes: new Uint8Array([255, 0]),
        amount: -9_007_199_254_740_993n,
      },
    };
    const encoded = JsonExt.stringify(source, undefined, { sortKeys: true });

    expect(encoded).toBe(
      '{"a":{"amount":"-9007199254740993n","bytes":{"data":[255,0],"type":"Buffer"},"date":"2026-01-01T00:00:00.000Z","rate":{"type":"BigNumber","value":"3e-19"}},"z":["2n","1n"]}',
    );
    expect(JsonExt.parse(encoded)).toEqual(source);
    expect(JsonExt.stringify({ z: 1, a: 2 })).toBe('{"z":1,"a":2}');
  });
});
