import { describe, expect, it } from 'vitest';
import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
  calculateModifiedDietzReturn,
  calculatePerformanceReturn,
} from '../src/FinancialReturns.ts';
import { calculateAPY, calculateProfitPct } from '../src/utils.ts';

describe('FinancialReturns', () => {
  it('aggregates undated positions by total capital instead of averaging participant returns', () => {
    expect(
      calculateAggregateReturn([
        { startingCapital: 100n, endingCapital: 200n },
        { startingCapital: 900n, endingCapital: 900n },
      ]),
    ).toEqual({
      basisPoints: 1_000n,
      percent: 10,
      eligibleCapitalInvested: 1_000n,
      totalProfits: 100n,
    });
  });

  it('aggregates realized income and current position value against invested capital', () => {
    const result = calculatePerformanceReturn(
      [
        {
          startingDate: new Date('2026-01-01T00:00:00Z'),
          startingCapital: 1_000n,
          endingCapital: 1_100n,
        },
        {
          startingDate: new Date('2026-01-01T00:00:00Z'),
          startingCapital: 2_000n,
          endingCapital: 2_100n,
        },
      ],
      { now: new Date('2026-01-11T00:00:00Z') },
    );

    expect(result).toEqual({
      basisPoints: 667n,
      percent: 6.67,
      eligibleCapitalInvested: 3_000n,
      totalProfits: 200n,
    });
  });

  it('gives newly invested capital only the weight of the time it has been deployed', () => {
    const result = calculatePerformanceReturn(
      [
        {
          startingDate: new Date('2026-01-01T00:00:00Z'),
          startingCapital: 1_000n,
          endingCapital: 1_100n,
        },
        {
          startingDate: new Date('2026-01-28T00:00:00Z'),
          startingCapital: 1_000n,
          endingCapital: 1_000n,
        },
      ],
      { now: new Date('2026-01-31T00:00:00Z') },
    );

    expect(result.percent).toBe(9.09);
  });

  it('time weights later capital additions within one investment', () => {
    const result = calculatePerformanceReturn(
      [
        {
          startingDate: new Date('2026-01-01T00:00:00Z'),
          startingCapital: 2_000n,
          endingCapital: 2_100n,
          capitalFlows: [
            { amount: 1_000n, occurredAt: new Date('2026-01-01T00:00:00Z') },
            { amount: 1_000n, occurredAt: new Date('2026-01-28T00:00:00Z') },
          ],
        },
      ],
      { now: new Date('2026-01-31T00:00:00Z') },
    );

    expect(result.percent).toBe(9.09);
  });

  it('weights external cash flows by how long they were invested', () => {
    const result = calculateModifiedDietzReturn({
      startingValue: 0n,
      endingValue: 180n,
      startingDate: new Date('2026-01-01T00:00:00Z'),
      endingDate: new Date('2026-01-11T00:00:00Z'),
      cashFlows: [
        { amount: 100n, occurredAt: new Date('2026-01-01T00:00:00Z') },
        { amount: 100n, occurredAt: new Date('2026-01-06T00:00:00Z') },
        { amount: -50n, occurredAt: new Date('2026-01-11T00:00:00Z') },
      ],
    });

    expect(result).toEqual({
      basisPoints: 2_000n,
      percent: 20,
      eligibleCapitalInvested: 150n,
      totalProfits: 30n,
    });
  });

  it('ignores cash flows after the return period', () => {
    const result = calculateModifiedDietzReturn({
      startingValue: 100n,
      endingValue: 110n,
      startingDate: new Date('2026-01-01T00:00:00Z'),
      endingDate: new Date('2026-01-11T00:00:00Z'),
      cashFlows: [{ amount: 50n, occurredAt: new Date('2026-01-12T00:00:00Z') }],
    });

    expect(result).toEqual({
      basisPoints: 1_000n,
      percent: 10,
      eligibleCapitalInvested: 100n,
      totalProfits: 10n,
    });
  });

  it('keeps projected APR and APY explicit about their measurement period', () => {
    const input = { startingValue: 1_000n, endingValue: 1_100n, periodDays: 10 };

    expect(calculateAnnualPercentageRate(input)).toBeCloseTo(365);
    expect(calculateAnnualPercentageYield(input)).toBeCloseTo((1.1 ** 36.5 - 1) * 100);
  });

  it('keeps small period returns when annualizing', () => {
    expect(
      calculateAnnualPercentageYield({
        startingValue: 1_000_000_000n,
        endingValue: 1_000_001_000n,
        periodDays: 1,
      }),
    ).toBeCloseTo((1.000001 ** 365 - 1) * 100);
  });

  it('reports a total loss as negative one hundred percent APY', () => {
    expect(calculateAnnualPercentageYield({ startingValue: 1_000n, endingValue: 0n, periodDays: 10 })).toBe(-100);
  });

  it('preserves the legacy display behavior when return inputs have no cost or rewards', () => {
    expect(calculateProfitPct(0n, 1n)).toBe(100_000_000);
    expect(calculateAPY(1_000n, 0n, 10)).toBe(0);
  });

  it('does not claim a return when no capital is eligible', () => {
    expect(calculatePerformanceReturn([])).toEqual({
      basisPoints: 0n,
      percent: 0,
      eligibleCapitalInvested: 0n,
      totalProfits: 0n,
    });
  });

  it('preserves minimum-age filtering before reducing dated positions', () => {
    const result = calculatePerformanceReturn(
      [
        {
          startingDate: new Date('2026-01-01T00:00:00Z'),
          startingCapital: 1_000n,
          endingCapital: 1_100n,
        },
        {
          startingDate: new Date('2026-01-09T00:00:00Z'),
          startingCapital: 9_000n,
          endingCapital: 18_000n,
        },
      ],
      {
        minimumAgeMs: 5 * 24 * 60 * 60 * 1_000,
        now: new Date('2026-01-10T00:00:00Z'),
      },
    );

    expect(result.eligibleCapitalInvested).toBe(1_000n);
    expect(result.totalProfits).toBe(100n);
    expect(result.percent).toBe(10);
  });
});
