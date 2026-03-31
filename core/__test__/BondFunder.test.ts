import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';

import { BondFunder } from '../src/BondFunder.ts';
import { compoundXTimes } from '../src/utils.ts';

describe('BondFunder', () => {
  it('calculates APY from large bigint treasury values without overflowing', () => {
    const funder = new BondFunder(
      '5Funder',
      {
        heldPrincipal: { toBigInt: () => 987_654_321_987_654_321_987_654_321n },
        pendingUnlockAmount: { toBigInt: () => 0n },
        pendingUnlockAtFrame: { isSome: false },
        lifetimeCompoundedEarnings: { toBigInt: () => 123_456_789_123_456_789_123_456n },
        lifetimePrincipalDeployed: { toBigInt: () => 456_789_123_456_789_123_456_789_123n },
        lifetimePrincipalLastBasisFrame: { toNumber: () => 100 },
      } as any,
      true,
    );

    const framesSinceBasis = 50;
    const effectiveDeployed =
      456_789_123_456_789_123_456_789_123n + 987_654_321_987_654_321_987_654_321n * BigInt(framesSinceBasis);
    const expectedPerFrameReturn = BigNumber('123456789123456789123456')
      .dividedBy(effectiveDeployed.toString())
      .toNumber();

    expect(funder.getAPY(150)).toBeCloseTo(compoundXTimes(expectedPerFrameReturn, 365) * 100, 12);
  });

  it('normalizes target principal across treasury models', () => {
    const newModelFunder = new BondFunder(
      '5New',
      {
        heldPrincipal: { toBigInt: () => 400n },
        pendingUnlockAmount: { toBigInt: () => 150n },
        pendingUnlockAtFrame: { isSome: true, unwrap: () => ({ toNumber: () => 12 }) },
        lifetimeCompoundedEarnings: { toBigInt: () => 0n },
        lifetimePrincipalDeployed: { toBigInt: () => 0n },
        lifetimePrincipalLastBasisFrame: { toNumber: () => 0 },
      } as any,
      true,
    );

    const oldModelFunder = new BondFunder(
      '5Old',
      {
        heldPrincipal: { toBigInt: () => 400n },
        targetPrincipal: { toBigInt: () => 250n },
        lifetimeCompoundedEarnings: { toBigInt: () => 0n },
        lifetimePrincipalDeployed: { toBigInt: () => 0n },
        lifetimePrincipalLastBasisFrame: { toNumber: () => 0 },
      } as any,
      true,
    );

    expect(newModelFunder.targetPrincipal).toBe(250n);
    expect(oldModelFunder.targetPrincipal).toBe(250n);
    expect(newModelFunder.pendingReturnAmount).toBe(150n);
    expect(oldModelFunder.pendingReturnAmount).toBe(150n);
  });
});
