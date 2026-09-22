import { describe, expect, it } from 'vitest';
import numeral from '../lib/numeral.ts';

describe('numeral', () => {
  it('formats finite values represented with scientific notation', () => {
    expect(numeral(1e-7).format('0,0.[00]')).toBe('0');
    expect(numeral(-1e-7).format('0,0.[00]')).toBe('0');
    expect(numeral(1e-7).format('0,0.[00000000]')).toBe('0.0000001');
    expect(numeral(-1e-7).format('0,0.[00000000]')).toBe('-0.0000001');
  });
});
