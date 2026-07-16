import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';

describe('VaultCapitalHistoryTable', () => {
  it('keeps finalized changes distinct by transaction and ignores repeated ingestion', async () => {
    const db = await createTestDb();
    const identity = {
      walletAddress: '5operator',
      vaultId: 7,
      eventType: 'released' as const,
      securitization: 40_000_000n,
      blockNumber: 101,
      blockHash: '0xblock101',
    };

    expect(db.vaultCapitalHistoryTable.revision).toBe(0);
    await db.vaultCapitalHistoryTable.insert({ ...identity, extrinsicIndex: 2 });
    await db.vaultCapitalHistoryTable.insert({ ...identity, extrinsicIndex: 3 });
    await db.vaultCapitalHistoryTable.insert({ ...identity, extrinsicIndex: 3, securitization: 50_000_000n });
    expect(db.vaultCapitalHistoryTable.revision).toBe(2);

    const records = await db.vaultCapitalHistoryTable.fetchAll('5operator', 7);
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({ eventType: 'released', securitization: 40_000_000n });
  });

  it('persists lost capital with block and extrinsic provenance', async () => {
    const db = await createTestDb();

    await db.vaultCapitalHistoryTable.insert({
      walletAddress: '5operator',
      vaultId: 7,
      eventType: 'capitalLost',
      amount: 40_000_000n,
      blockNumber: 102,
      blockHash: '0xblock102',
      extrinsicIndex: 4,
    });

    expect(await db.vaultCapitalHistoryTable.fetchAll('5operator', 7)).toEqual([
      expect.objectContaining({
        eventType: 'capitalLost',
        amount: 40_000_000n,
        blockNumber: 102,
        blockHash: '0xblock102',
        extrinsicIndex: 4,
      }),
    ]);
  });
});
