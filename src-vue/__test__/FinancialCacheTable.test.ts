import { describe, expect, it } from 'vitest';
import { MoveToken, UnitOfMeasurement } from '@argonprotocol/apps-core';
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

  it('round trips crosschain history snapshots with dates and bigints', async () => {
    const db = await createTestDb();
    const snapshot = {
      records: [
        {
          accountId: '5vault',
          id: '0xblock:2',
          blockNumber: 10,
          blockTime: new Date('2026-08-15T12:00:00.000Z'),
          extrinsicIndex: 1,
          eventIndex: 2,
          details: {
            kind: 'transferAuthorization' as const,
            transferId: '0xtransfer',
            authoritySigningKey: '0xauthority',
            sourceAccount: '5source',
            destinationAccount: '0xrecipient',
            moveToken: MoveToken.ARGN,
            amount: 5_000_000n,
            tip: 50_000n,
            microgonCollateral: 10_000_000n,
            micronotCollateral: 1_000_000n,
          },
        },
      ],
      definitionVersion: 3,
      refreshedThroughBlock: 10,
    };

    await db.financialCacheTable.upsert(FinancialCacheTypes.CrosschainHistory, '5vault', snapshot);

    await expect(db.financialCacheTable.get(FinancialCacheTypes.CrosschainHistory, '5vault')).resolves.toEqual(
      snapshot,
    );
  });
});
