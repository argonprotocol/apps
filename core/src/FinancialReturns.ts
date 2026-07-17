import BigNumber from 'bignumber.js';

export type IPerformanceReturnInput = {
  startingDate: Date | number | string;
  startingCapital: bigint;
  endingDate?: Date | number | string | null;
  endingCapital: bigint;
};

export type IAggregateReturnInput = Pick<IPerformanceReturnInput, 'startingCapital' | 'endingCapital'>;

export type IPerformanceReturnOptions = {
  /**
   * Exclude investments younger than this amount of time.
   *
   * Useful for preventing brand-new capital from immediately dragging down
   * the displayed performance return.
   */
  minimumAgeMs?: number;

  /**
   * Optional override for testing or deterministic calculations.
   * Defaults to new Date().
   */
  now?: Date;
};

export type IPerformanceReturnResult = {
  /**
   * Return in basis points.
   *
   * 1 basis point = 0.01%
   * Example: 7924n = 79.24%
   */
  basisPoints: bigint;

  /**
   * Return as a percentage number.
   * Example: 79.24
   */
  percent: number;

  /** Capital included in the performance calculation. */
  eligibleCapitalInvested: bigint;

  /** Profits included in the performance calculation. */
  totalProfits: bigint;
};

export type IAnnualizedReturnInput = {
  startingValue: bigint;
  endingValue: bigint;
  periodDays: number;
};

const BASIS_POINTS_PER_100_PERCENT = 10_000n;
const DAYS_PER_YEAR = 365;
const MAX_RETURN_RATIO = 100_000_000;

export function calculatePerformanceReturn(
  investments: readonly IPerformanceReturnInput[],
  options: IPerformanceReturnOptions = {},
): IPerformanceReturnResult {
  const nowMs = BigInt((options.now ?? new Date()).getTime());
  const minimumAgeMs = BigInt(options.minimumAgeMs ?? 0);

  const eligibleInvestments = investments.filter(investment => {
    if (investment.startingCapital <= 0n) return false;

    const startMs = toDateMs(investment.startingDate);
    const endMs = investment.endingDate ? toDateMs(investment.endingDate) : nowMs;
    return endMs - startMs >= minimumAgeMs;
  });

  return calculateAggregateReturn(eligibleInvestments);
}

export function calculateAggregateReturn(investments: readonly IAggregateReturnInput[]): IPerformanceReturnResult {
  let eligibleCapitalInvested = 0n;
  let totalProfits = 0n;

  for (const investment of investments) {
    if (investment.startingCapital <= 0n) continue;

    eligibleCapitalInvested += investment.startingCapital;
    totalProfits += investment.endingCapital - investment.startingCapital;
  }

  const basisPoints = divideAndRound(totalProfits * BASIS_POINTS_PER_100_PERCENT, eligibleCapitalInvested);

  return {
    basisPoints,
    percent: Number(basisPoints) / 100,
    eligibleCapitalInvested,
    totalProfits,
  };
}

export function calculatePeriodReturn(startingValue: bigint, endingValue: bigint): number {
  if (startingValue === 0n && endingValue > 0n) return MAX_RETURN_RATIO;
  if (startingValue === 0n) return 0;

  return Number(((endingValue - startingValue) * 100_000n) / startingValue) / 100_000;
}

export function calculateAnnualPercentageRate(input: IAnnualizedReturnInput): number {
  if (input.periodDays <= 0) return 0;

  return annualizeSimpleReturn(calculateReturnRatio(input.startingValue, input.endingValue), input.periodDays);
}

export function calculateAnnualPercentageYield(input: IAnnualizedReturnInput): number {
  if (input.periodDays <= 0) return 0;

  const periodReturn = calculateReturnRatio(input.startingValue, input.endingValue);

  return annualizeCompoundedReturn(periodReturn, input.periodDays);
}

export function annualizeSimpleReturn(periodReturn: number, periodDays: number): number {
  if (periodDays <= 0) return 0;

  return Math.max(periodReturn * (DAYS_PER_YEAR / periodDays) * 100, -100);
}

export function annualizeCompoundedReturn(periodReturn: number, periodDays: number): number {
  if (periodDays <= 0) return 0;
  if (periodReturn <= -1) return -100;

  return (Math.pow(1 + periodReturn, DAYS_PER_YEAR / periodDays) - 1) * 100;
}

function toDateMs(value: Date | number | string): bigint {
  if (value instanceof Date) return BigInt(value.getTime());
  if (typeof value === 'number') return BigInt(value);
  return BigInt(new Date(value).getTime());
}

function divideAndRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;

  const isNegative = numerator < 0n;
  const absoluteNumerator = isNegative ? -numerator : numerator;
  const rounded = (absoluteNumerator + denominator / 2n) / denominator;

  return isNegative ? -rounded : rounded;
}

function calculateReturnRatio(startingValue: bigint, endingValue: bigint): number {
  if (startingValue === 0n && endingValue > 0n) return MAX_RETURN_RATIO;
  if (startingValue === 0n) return 0;

  return BigNumber(endingValue - startingValue)
    .dividedBy(startingValue)
    .toNumber();
}
