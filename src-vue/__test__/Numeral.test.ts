import { describe, expect, it } from 'vitest';
import numeral from '../lib/numeral.ts';

describe('numeral', () => {
  it('formats finite values represented with scientific notation', () => {
    expect(numeral(1e-7).format('0,0.[00]')).toBe('0');
    expect(numeral(-1e-7).format('0,0.[00]')).toBe('0');
    expect(numeral(1e-7).format('0,0.[00000000]')).toBe('0.0000001');
    expect(numeral(-1e-7).format('0,0.[00000000]')).toBe('-0.0000001');
  });

  it('keeps positive sub-cent currency values visible without treating zero as an earning', () => {
    expect(numeral(0).formatCurrency('₳')).toBe('₳0.00');
    expect(numeral(1e-7).formatCurrency('₳')).toBe('<₳0.01');
    expect(numeral(0.0099).formatCurrency('$')).toBe('<$0.01');
    expect(numeral(0.01).formatCurrency('₳')).toBe('₳0.01');
    expect(numeral(-1.23).formatCurrency('$')).toBe('$-1.23');
  });

  it('preserves two decimals unless the caller selects a whole-number threshold', () => {
    expect(numeral(1_234.56).formatCurrency('₳')).toBe('₳1,234.56');
    expect(numeral(999.5).formatCurrency('₳', 1_000)).toBe('₳999.50');
    expect(numeral(1_000).formatCurrency('₳', 1_000)).toBe('₳1,000');
    expect(numeral(1_234.56).formatCurrency('₳', 1_000)).toBe('₳1,235');
  });
});
