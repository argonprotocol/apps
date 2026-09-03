import { describe, expect, it } from 'vitest';

import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { allocateBitcoinInsuranceCosts } from '../lib/financials/BitcoinInsurance.ts';

describe('Bitcoin Liquid insurance allocation', () => {
  it('keeps the full term cost on the first Liquid until a later Liquid event redistributes it', () => {
    const terms = [createTerm({ endTick: undefined })];
    const firstLiquid = createFission({ fissionId: 1, liquidId: 1, createdAtTick: 10 });

    expect(
      allocateBitcoinInsuranceCosts({
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
      allocateBitcoinInsuranceCosts({
        terms,
        fissions: [closedFirstLiquid],
      }).costByLiquidId,
    ).toEqual(new Map([[1, 1_000n]]));

    const allocation = allocateBitcoinInsuranceCosts({
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

  it('partitions concurrent Liquids into exact insured satoshi slices', () => {
    const allocation = allocateBitcoinInsuranceCosts({
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
    const allocation = allocateBitcoinInsuranceCosts({
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

  it('marks a Liquid incomplete when its tick history cannot place its insured slice', () => {
    const allocation = allocateBitcoinInsuranceCosts({
      terms: [createTerm()],
      fissions: [createFission({ fissionId: 1, liquidId: 7, createdAtTick: undefined })],
    });

    expect(allocation.costByLiquidId).toEqual(new Map());
    expect(allocation.incompleteLiquidIds).toEqual(new Set([7]));
  });

  it('marks a Liquid incomplete instead of treating missing securitization history as free insurance', () => {
    const allocation = allocateBitcoinInsuranceCosts({
      terms: [],
      fissions: [createFission({ fissionId: 1, liquidId: 7, createdAtTick: 10 })],
    });

    expect(allocation.costByLiquidId).toEqual(new Map());
    expect(allocation.incompleteLiquidIds).toEqual(new Set([7]));
  });
});

function createTerm(overrides: Partial<IBitcoinSecuritizationTerm> = {}): IBitcoinSecuritizationTerm {
  return {
    utxoId: 7,
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
    utxoId: 7,
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
