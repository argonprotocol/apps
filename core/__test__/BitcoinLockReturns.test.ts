import { describe, expect, it } from 'vitest';
import { calculateBitcoinRatchetReturn } from '../src/BitcoinLockReturns.ts';

describe('BitcoinLockReturns', () => {
  it('uses the mainchain remaining-term proration for upward ratchet fees', () => {
    const result = calculateBitcoinRatchetReturn({
      prices: [
        { date: '2025-01-01', price: 100 },
        { date: '2025-07-03', price: 120 },
        { date: '2026-01-01', price: 120 },
      ],
      flatFee: 2,
      percentageFee: 5,
      ratchetThreshold: 0.1,
    });

    expect(result.ratchetCount).toBe(1);
    expect(result.finalLockPrice).toBe(120);
    expect(result.grossFees).toBe(9_498_630n);
    expect(result.percent).toBe(9.59);
  });

  it('nets vault-paid coupon reimbursement against fees', () => {
    const result = calculateBitcoinRatchetReturn({
      prices: [
        { date: '2025-01-01', price: 100 },
        { date: '2026-01-01', price: 100 },
      ],
      flatFee: 2,
      percentageFee: 5,
      ratchetThreshold: 0.1,
      couponFeesPaid: 10,
    });

    expect(result.grossFees).toBe(7_000_000n);
    expect(result.couponFeesPaid).toBe(10_000_000n);
    expect(result.netFees).toBe(0n);
    expect(result.percent).toBe(0);
  });
});
