import { describe, expect, it } from 'vitest';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { FinancialCacheTypes } from '../lib/db/FinancialCacheTable.ts';
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
});
