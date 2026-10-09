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

  it('formats percentage points and keeps positive values below the displayed precision visible', () => {
    expect(numeral(0).formatPercent()).toBe('0.0%');
    expect(numeral(1e-7).formatPercent()).toBe('<0.1%');
    expect(numeral(0.0999).formatPercent()).toBe('<0.1%');
    expect(numeral(0.1).formatPercent()).toBe('0.1%');
    expect(numeral(50).formatPercent()).toBe('50.0%');
    expect(numeral(-0.1).formatPercent()).toBe('-0.1%');
    expect(numeral(1_234.56).formatPercent()).toBe('1,234.6%');
    expect(numeral(0.001).formatPercent(2)).toBe('<0.01%');
    expect(numeral(0.01).formatPercent(2)).toBe('0.01%');
    expect(numeral(50).formatPercent(0)).toBe('50%');
  });
});
