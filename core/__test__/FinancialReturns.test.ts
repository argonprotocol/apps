import { describe, expect, it } from 'vitest';
import {
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
  calculatePerformanceReturn,
} from '../src/FinancialReturns.ts';
import { calculateAPY, calculateProfitPct } from '../src/utils.ts';

describe('FinancialReturns', () => {
  it('aggregates realized income and current position value against invested capital', () => {
    const result = calculatePerformanceReturn([
      {
        startingDate: new Date('2026-01-01T00:00:00Z'),
        startingCapital: 1_000n,
        endingCapital: 1_100n,
      },
      {
        startingDate: new Date('2026-01-02T00:00:00Z'),
        startingCapital: 2_000n,
        endingDate: new Date('2026-01-12T00:00:00Z'),
        endingCapital: 2_100n,
      },
    ]);

    expect(result).toEqual({
      basisPoints: 667n,
      percent: 6.67,
      eligibleCapitalInvested: 3_000n,
      totalProfits: 200n,
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
});
