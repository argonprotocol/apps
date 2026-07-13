import { describe, expect, it } from 'vitest';

import { MICRONOTS_PER_ARGONOT } from '../src/Currency.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';

describe('TreasuryBonds', () => {
  it('limits Argonot purchases to the unfilled portion of the circulation cap', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondPurchaseCapacity({
        totalIssuanceMicronots: 1_000n * oneArgonot,
        maxBondedPercent: 40,
        totalActiveBonds: 325,
      }),
    ).toBe(75n * oneArgonot);
  });
});
