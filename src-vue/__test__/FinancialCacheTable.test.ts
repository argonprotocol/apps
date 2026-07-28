import { describe, expect, it } from 'vitest';
import { type IMiningSummary, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { FinancialCacheTypes, MiningSummaryCacheScope } from '../lib/db/FinancialCacheTable.ts';
import { createTestDb } from './helpers/db.ts';

describe('FinancialCacheTable', () => {
  it('round trips typed financial cache entries', async () => {
    const db = await createTestDb();
    const observedAt = new Date('2026-07-17T12:00:00Z');

    await db.financialCacheTable.upsert(FinancialCacheTypes.ExternalWalletBalance, 'base:0xabcdef', {
      chain: 'base',
      address: '0xabcdef',
      availableMicrogons: 0n,
      availableMicronots: 0n,
      otherTokens: [
        {
          symbol: 'USDC',
          decimals: 6,
          address: '0x0000000000000000000000000000000000000001',
          chain: 'base',
          unitOfMeasurement: UnitOfMeasurement.USDC,
          value: 12_500_000n,
        },
      ],
      observedAt,
    });
    await expect(
      db.financialCacheTable.get(FinancialCacheTypes.ExternalWalletBalance, 'base:0xabcdef'),
    ).resolves.toEqual({
      chain: 'base',
      address: '0xabcdef',
      availableMicrogons: 0n,
      availableMicronots: 0n,
      otherTokens: [
        {
          symbol: 'USDC',
          decimals: 6,
          address: '0x0000000000000000000000000000000000000001',
          chain: 'base',
          unitOfMeasurement: UnitOfMeasurement.USDC,
          value: 12_500_000n,
        },
      ],
      observedAt,
    });
  });

  it('round trips a mining summary with bigint values and its observation date', async () => {
    const db = await createTestDb();
    const observedAt = new Date('2026-07-28T12:00:00Z');
    const summary: IMiningSummary = {
      observedAt,
      sourceBlockNumber: 456,
      latestFrameId: 12,
      cohorts: [],
      currentBids: [],
      frames: [],
      global: {
        seatsTotal: 1,
        framesCompleted: 2,
        framesRemaining: 8,
        framedCost: 3_000_000n,
        transactionFeesTotal: 100n,
        microgonsBidTotal: 30_000_000n,
        micronotsMinedTotal: 400n,
        microgonsMinedTotal: 500n,
        microgonsMintedTotal: 600n,
      },
    };

    await db.financialCacheTable.upsert(FinancialCacheTypes.MiningSummary, MiningSummaryCacheScope, summary);

    await expect(
      db.financialCacheTable.get(FinancialCacheTypes.MiningSummary, MiningSummaryCacheScope),
    ).resolves.toEqual(summary);
  });
});
