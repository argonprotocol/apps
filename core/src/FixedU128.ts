/** Substrate FixedU128's unsigned, 18-place arithmetic. */
export const FIXED_U128_ONE = 10n ** 18n;
export const U128_MAX = (1n << 128n) - 1n;

/** from_rational and checked_div round to nearest, with ties rounded down. */
export function fixedU128Rational(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('FixedU128 requires a positive denominator');
  const scaled = numerator * FIXED_U128_ONE;
  const quotient = scaled / denominator;
  const rounded = quotient + (2n * (scaled % denominator) > denominator ? 1n : 0n);
  return rounded > U128_MAX ? U128_MAX : rounded;
}

/** saturating_mul truncates at each multiplication, rather than at the final payout. */
export function fixedU128Multiply(left: bigint, right: bigint): bigint {
  const result = (left * right) / FIXED_U128_ONE;
  return result > U128_MAX ? U128_MAX : result;
}
