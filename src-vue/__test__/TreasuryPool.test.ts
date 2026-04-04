import { describe, expect, it } from 'vitest';
import { TreasuryPool } from '@argonprotocol/apps-core';

describe('getTreasuryBondPurchaseCapacity', () => {
  it('keeps the full capacity in the simplified bonds model', () => {
    expect(TreasuryPool.getBondPurchaseCapacity(1_500n, true)).toBe(1_500n);
    expect(TreasuryPool.getBondPurchaseCapacity(0n, true)).toBe(0n);
  });

  it('uses the legacy staggered capacity in the older bonds model', () => {
    expect(TreasuryPool.getBondPurchaseCapacity(1_500n, false)).toBe(150n);
  });
});

describe('calculateNextFrameBondAvailability', () => {
  it('uses target principal so scheduled bond exits reopen room next frame', () => {
    const availability = TreasuryPool.calculateNextFrameBondAvailability(
      1_000n,
      [{ targetPrincipal: 40n }, { targetPrincipal: 35n }],
      false,
    );

    expect(availability).toEqual({
      nextFrameCapacity: 100n,
      totalTargetPrincipal: 75n,
      nextFrameAvailable: 25n,
    });
  });

  it('shows no room when the next frame is already full', () => {
    const availability = TreasuryPool.calculateNextFrameBondAvailability(
      1_000n,
      [{ targetPrincipal: 40n }, { targetPrincipal: 60n }],
      false,
    );

    expect(availability.nextFrameAvailable).toBe(0n);
  });

  it('grows when confirmed BTC-backed capacity grows', () => {
    const availability = TreasuryPool.calculateNextFrameBondAvailability(1_500n, [{ targetPrincipal: 100n }], false);

    expect(availability).toEqual({
      nextFrameCapacity: 150n,
      totalTargetPrincipal: 100n,
      nextFrameAvailable: 50n,
    });
  });

  it('clamps oversubscribed targets to zero available room', () => {
    const availability = TreasuryPool.calculateNextFrameBondAvailability(1_000n, [{ targetPrincipal: 125n }], false);

    expect(availability.nextFrameAvailable).toBe(0n);
  });

  it('uses the full treasury capacity in the simplified bonds model', () => {
    const availability = TreasuryPool.calculateNextFrameBondAvailability(1_500n, [{ targetPrincipal: 100n }], true);

    expect(availability).toEqual({
      nextFrameCapacity: 1_500n,
      totalTargetPrincipal: 100n,
      nextFrameAvailable: 1_400n,
    });
  });
});
