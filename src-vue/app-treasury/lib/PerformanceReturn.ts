// PerformanceReturn.ts

export type IPerformanceReturnInput = {
  startingDate: Date | number | string;
  startingCapital: bigint;
  endingDate?: Date | number | string | null;
  endingCapital: bigint;
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

  /**
   * Capital included in the performance calculation.
   */
  eligibleCapitalInvested: bigint;

  /**
   * Profits included in the performance calculation.
   */
  totalProfits: bigint;
};

const BASIS_POINTS_PER_100_PERCENT = 10_000n;

function toDateMs(value: Date | number | string): bigint {
  if (value instanceof Date) {
    return BigInt(value.getTime());
  }

  if (typeof value === 'number') {
    return BigInt(value);
  }

  return BigInt(new Date(value).getTime());
}

function divideAndRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;

  const isNegative = numerator < 0n;
  const absoluteNumerator = isNegative ? -numerator : numerator;

  const rounded = (absoluteNumerator + denominator / 2n) / denominator;

  return isNegative ? -rounded : rounded;
}

export function calculatePerformanceReturn(
  investments: IPerformanceReturnInput[],
  options: IPerformanceReturnOptions = {},
): IPerformanceReturnResult {
  const nowMs = BigInt((options.now ?? new Date()).getTime());
  const minimumAgeMs = BigInt(options.minimumAgeMs ?? 0);

  let eligibleCapitalInvested = 0n;
  let totalProfits = 0n;

  for (const investment of investments) {
    const startCapital = investment.startingCapital;
    const profit = investment.endingCapital - startCapital;

    if (startCapital <= 0n) {
      continue;
    }

    const startMs = toDateMs(investment.startingDate);
    const endMs = investment.endingDate ? toDateMs(investment.endingDate) : nowMs;

    const ageMs = endMs - startMs;

    if (ageMs < minimumAgeMs) {
      continue;
    }

    eligibleCapitalInvested += startCapital;
    totalProfits += profit;
  }

  if (eligibleCapitalInvested === 0n) {
    return {
      basisPoints: 0n,
      percent: 0,
      eligibleCapitalInvested,
      totalProfits,
    };
  }

  const basisPoints = divideAndRound(totalProfits * BASIS_POINTS_PER_100_PERCENT, eligibleCapitalInvested);

  return {
    basisPoints,
    percent: Number(basisPoints) / 100,
    eligibleCapitalInvested,
    totalProfits,
  };
}
