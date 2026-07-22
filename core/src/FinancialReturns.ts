import BigNumber from 'bignumber.js';

export type IPerformanceReturnInput = {
  startingDate: Date | number | string;
  startingCapital: bigint;
  endingDate?: Date | number | string | null;
  endingCapital: bigint;
  capitalFlows?: readonly ICapitalFlow[];
};

export type IAggregateReturnInput = Pick<IPerformanceReturnInput, 'startingCapital' | 'endingCapital'>;

export type ICapitalFlow = {
  amount: bigint;
  occurredAt: Date | number | string;
};

export type IAccountCashFlow = ICapitalFlow;

export type IModifiedDietzReturnInput = {
  startingValue: bigint;
  endingValue: bigint;
  startingDate: Date | number | string;
  endingDate: Date | number | string;
  cashFlows: readonly ICapitalFlow[];
};

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
  let eligibleCapitalInvested = 0n;
  let totalProfits = 0n;
  let weightedCapitalMs = 0n;
  let weightedProfitMs = 0n;

  for (const investment of investments) {
    if (investment.startingCapital <= 0n) continue;

    const startMs = toDateMs(investment.startingDate);
    const endMs = investment.endingDate ? toDateMs(investment.endingDate) : nowMs;
    const durationMs = endMs - startMs;
    if (durationMs < minimumAgeMs) continue;

    const profit = investment.endingCapital - investment.startingCapital;
    const capitalMs = investment.capitalFlows
      ? calculateCapitalTime(investment.capitalFlows, startMs, endMs)
      : investment.startingCapital * durationMs;

    eligibleCapitalInvested += investment.startingCapital;
    totalProfits += profit;
    if (durationMs <= 0n || capitalMs <= 0n) continue;

    // Normalize each position over its own active duration, then combine positions by their capital-time exposure.
    weightedCapitalMs += capitalMs;
    weightedProfitMs += profit * durationMs;
  }

  const basisPoints = divideAndRound(weightedProfitMs * BASIS_POINTS_PER_100_PERCENT, weightedCapitalMs);

  return {
    basisPoints,
    percent: Number(basisPoints) / 100,
    eligibleCapitalInvested,
    totalProfits,
  };
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

export function calculateModifiedDietzReturn(input: IModifiedDietzReturnInput): IPerformanceReturnResult {
  const startingMs = toDateMs(input.startingDate);
  const endingMs = toDateMs(input.endingDate);
  const durationMs = endingMs > startingMs ? endingMs - startingMs : 0n;
  let netCashFlows = 0n;
  let contributedCapital = 0n;
  let weightedCapitalMs = input.startingValue * durationMs;

  for (const cashFlow of input.cashFlows) {
    const occurredAtMs = toDateMs(cashFlow.occurredAt);
    if (occurredAtMs > endingMs) continue;

    netCashFlows += cashFlow.amount;
    if (cashFlow.amount > 0n) contributedCapital += cashFlow.amount;
  }
  weightedCapitalMs += calculateCapitalTime(input.cashFlows, startingMs, endingMs);

  const totalProfits = input.endingValue - input.startingValue - netCashFlows;
  let eligibleCapitalInvested =
    durationMs > 0n ? divideAndRound(weightedCapitalMs, durationMs) : input.startingValue + contributedCapital;
  if (eligibleCapitalInvested <= 0n) eligibleCapitalInvested = input.startingValue + contributedCapital;
  if (eligibleCapitalInvested <= 0n) eligibleCapitalInvested = 0n;
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

function calculateCapitalTime(capitalFlows: readonly ICapitalFlow[], startingMs: bigint, endingMs: bigint): bigint {
  let capitalMs = 0n;

  for (const flow of capitalFlows) {
    const occurredAtMs = toDateMs(flow.occurredAt);
    if (occurredAtMs > endingMs) continue;

    const boundedOccurredAtMs = occurredAtMs < startingMs ? startingMs : occurredAtMs;
    const remainingMs = boundedOccurredAtMs < endingMs ? endingMs - boundedOccurredAtMs : 0n;
    capitalMs += flow.amount * remainingMs;
  }

  return capitalMs;
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
