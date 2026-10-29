import { describe, expect, it, vi } from 'vitest';

import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { allocateBitcoinCosignerGuaranteeCosts } from '../lib/financials/BitcoinCosignerGuarantee.ts';

describe('Bitcoin Liquid cosigner guarantee allocation', () => {
  it('keeps the full term cost on the first Liquid until a later Liquid event redistributes it', () => {
    const terms = [createTerm({ endTick: undefined })];
    const firstLiquid = createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10 });

    expect(
      allocateBitcoinCosignerGuaranteeCosts({
        terms,
        fissions: [firstLiquid],
      }).costByLiquidId,
    ).toEqual(new Map([[1, 1_000n]]));

    const closedFirstLiquid = createFission({
      fissionId: 1,
      liquidId: 1,
      createdAtTick: 10,
      closedAtArgonBlock: 40,
      closedAtTick: 40,
    });
    expect(
      allocateBitcoinCosignerGuaranteeCosts({
        terms,
        fissions: [closedFirstLiquid],
      }).costByLiquidId,
    ).toEqual(new Map([[1, 1_000n]]));

    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms,
      fissions: [closedFirstLiquid, createFission({ fissionId: 2, liquidId: 2, createdAtTick: 60 })],
    });

    expect(allocation.costByLiquidId).toEqual(
      new Map([
        [1, 667n],
        [2, 333n],
      ]),
    );
    expect(allocation.unallocatedCost).toBe(0n);
    expect(allocation.incompleteLiquidIds).toEqual(new Set());
  });

  it('partitions concurrent Liquids into exact guaranteed satoshi slices', () => {
    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms: [createTerm()],
      fissions: [
        createFission({ fissionId: 1, liquidId: 1, satoshis: 40n, createdAtTick: 0, closedAtTick: 100 }),
        createFission({ fissionId: 2, liquidId: 2, satoshis: 60n, createdAtTick: 20, closedAtTick: 80 }),
      ],
    });

    expect(allocation.costByLiquidId).toEqual(
      new Map([
        [1, 400n],
        [2, 480n],
      ]),
    );
    expect(allocation.unallocatedCost).toBe(120n);
  });

  it('ends the old term and starts the resecuritized term at the same tick', () => {
    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms: [
        createTerm({ termIndex: 0, startTick: 0, endTick: 50, addedNetSecurityFee: 500n }),
        createTerm({
          termIndex: 1,
          origin: 'resecuritized',
          startTick: 50,
          endTick: 100,
          addedNetSecurityFee: 1_000n,
        }),
      ],
      fissions: [
        createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10, closedAtTick: 80 }),
        createFission({ fissionId: 2, liquidId: 2, createdAtTick: 90, closedAtTick: 100 }),
      ],
    });

    expect(allocation.costByLiquidId).toEqual(
      new Map([
        [1, 1_100n],
        [2, 400n],
      ]),
    );
    expect(allocation.unallocatedCost).toBe(0n);
  });

  it.each([
    {
      satoshis: 50n,
      expectedCosts: new Map([
        [1, 22n],
        [2, 5n],
      ]),
    },
    { satoshis: 200n, expectedCosts: new Map([[1, 27n]]) },
  ])(
    'shares only the Lock-covered slice and retains direct Fission fees for $satoshis satoshis',
    ({ satoshis, expectedCosts }) => {
      const first = createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10, satoshis });
      const second = createFission({ fissionId: 2, liquidId: 2, createdAtTick: 10, satoshis: 50n });
      first.ratchets = [
        {
          source: 'fission',
          sourceRatchetIndex: 1,
          microgonsAtTargetPerBtc: 100n,
          amountMinted: 0n,
          amountBurned: 0n,
          mintPending: 0n,
          blockNumber: 20,
          netSecurityFee: 17n,
        },
      ];
      const allocation = allocateBitcoinCosignerGuaranteeCosts({
        terms: [createTerm({ securitizedSatoshis: 100n, addedNetSecurityFee: 10n, cumulativeNetSecurityFee: 10n })],
        fissions: [first, second],
      });
      expect(allocation.costByLiquidId).toEqual(expectedCosts);
      expect(allocation.unallocatedCost).toBe(0n);
      expect(allocation.incompleteLiquidIds).toEqual(new Set());

      const afterPartialReturn = allocateBitcoinCosignerGuaranteeCosts({
        terms: [
          createTerm({
            securitizedSatoshis: 100n,
            addedNetSecurityFee: 10n,
            cumulativeNetSecurityFee: 10n,
            endTick: 20,
          }),
          createTerm({
            termIndex: 1,
            origin: 'partial-release',
            startTick: 20,
            securitizedSatoshis: 10n,
            addedNetSecurityFee: 0n,
            cumulativeNetSecurityFee: 10n,
          }),
        ],
        fissions: [first, second],
      });
      expect(afterPartialReturn).toEqual(allocation);

      // An offline ratchet is visible in current storage before recovery has its fee event.
      first.ratchetNumber = 2;
      const awaitingHistory = allocateBitcoinCosignerGuaranteeCosts({
        terms: [createTerm({ securitizedSatoshis: 100n, addedNetSecurityFee: 10n, cumulativeNetSecurityFee: 10n })],
        fissions: [first, second],
      });
      expect(awaitingHistory.incompleteLiquidIds).toEqual(new Set([first.liquidId]));
    },
  );

  it('marks a Liquid incomplete when its tick history cannot place its guaranteed slice', () => {
    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms: [createTerm()],
      fissions: [createFission({ fissionId: 1, liquidId: 7, createdAtTick: undefined })],
    });

    expect(allocation.costByLiquidId).toEqual(new Map());
    expect(allocation.incompleteLiquidIds).toEqual(new Set([7]));
  });

  it('marks a Liquid incomplete instead of treating missing securitization history as a free cosigner guarantee', () => {
    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms: [],
      fissions: [createFission({ fissionId: 1, liquidId: 7, createdAtTick: 10 })],
    });

    expect(allocation.costByLiquidId).toEqual(new Map());
    expect(allocation.incompleteLiquidIds).toEqual(new Set([7]));
  });

  it('does not assign a cumulative current term to the latest Liquid when the first term is missing', () => {
    const fissions = [
      createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10, closedAtArgonBlock: 40, closedAtTick: 40 }),
      createFission({ fissionId: 2, liquidId: 2, createdAtTick: 60 }),
    ];
    const allocation = allocateBitcoinCosignerGuaranteeCosts({
      terms: [createTerm({ startTick: 50, endTick: undefined })],
      fissions,
    });

    expect(allocation.costByLiquidId).toEqual(new Map());
    expect(allocation.incompleteLiquidIds).toEqual(new Set([1, 2]));
    expect(allocation.unallocatedCost).toBe(1_000n);
  });

  it('recomputes the same fixed allocation at different wall-clock times until a recorded event arrives', () => {
    vi.useFakeTimers();
    const terms = [createTerm({ endTick: undefined })];
    const first = createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10 });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const initial = allocateBitcoinCosignerGuaranteeCosts({ terms, fissions: [first] });
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const later = allocateBitcoinCosignerGuaranteeCosts({ terms, fissions: [first] });
    vi.useRealTimers();

    expect(later.costByLiquidId).toEqual(initial.costByLiquidId);
    expect(later.unallocatedCost).toBe(initial.unallocatedCost);
  });
});

function createTerm(overrides: Partial<IBitcoinSecuritizationTerm> = {}): IBitcoinSecuritizationTerm {
  return {
    lockId: 7,
    termIndex: 0,
    origin: 'created',
    startTick: 0,
    startBlockNumber: 159,
    securitizedSatoshis: 100n,
    securitizationCoverageMicrogons: 1_000n,
    cumulativeNetSecurityFee: 1_000n,
    addedNetSecurityFee: 1_000n,
    endTick: 100,
    ...overrides,
  };
}

function createFission(overrides: Partial<IBitcoinFissionRecord>): IBitcoinFissionRecord {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  return {
    origin: 'created',
    ownerAccount: '5owner',
    fissionId: 1,
    liquidId: 1,
    lockId: 7,
    satoshis: 100n,
    microgonsAtTargetPerBtc: 1_000n,
    liquidityPromised: 1_000n,
    createdAtArgonBlock: 159,
    ratchetNumber: 0,
    lastUpdatedArgonBlock: 159,
    ratchets: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
