import { describe, expect, it } from 'vitest';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { createTestDb } from './helpers/db.ts';

describe('ExternalWalletBalanceCacheTable', () => {
  it('round trips the last successful external wallet balance', async () => {
    const db = await createTestDb();
    const observedAt = new Date('2026-07-17T12:00:00Z');

    await db.externalWalletBalanceCacheTable.upsert({
      chain: 'base',
      address: '0xABCDEF',
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

    await expect(db.externalWalletBalanceCacheTable.get('base', '0xabcdef')).resolves.toEqual({
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
