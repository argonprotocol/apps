import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';

describe('VaultRevenueEventsTable', () => {
  it('uses one collection per block while preserving distinct burns and pre-extrinsic history', async () => {
    const db = await createTestDb();
    const event = {
      amount: 20_000_000n,
      source: 'vaultCollect' as const,
      blockNumber: 101,
      blockHash: '0xblock101',
    };

    expect(db.vaultRevenueEventsTable.revision).toBe(0);
    await db.vaultRevenueEventsTable.insert({ ...event, extrinsicIndex: 2 });
    await db.vaultRevenueEventsTable.insert({ ...event, amount: 30_000_000n, extrinsicIndex: 2 });
    expect(db.vaultRevenueEventsTable.revision).toBe(1);
    await db.vaultRevenueEventsTable.insert({ ...event, amount: 5_000_000n, extrinsicIndex: 3 });
    expect(db.vaultRevenueEventsTable.revision).toBe(1);
    await db.vaultRevenueEventsTable.insert({
      ...event,
      amount: 25_000_000n,
      blockHash: '0xcanonical101',
      extrinsicIndex: 2,
    });
    expect(db.vaultRevenueEventsTable.revision).toBe(2);

    await db.vaultRevenueEventsTable.insert({
      ...event,
      amount: 7_000_000n,
      source: 'vaultBurn',
      blockNumber: 102,
      blockHash: '0xblock102',
    });
    await db.vaultRevenueEventsTable.insert({
      ...event,
      amount: 8_000_000n,
      source: 'vaultBurn',
      blockNumber: 102,
      blockHash: '0xblock102',
    });

    await db.execute(
      `INSERT INTO VaultRevenueEvents (amount, source, blockNumber, blockHash)
       VALUES (?, ?, ?, ?)`,
      ['99000000', 'vaultCollect', 90, '0xlegacy'],
    );
    await db.vaultRevenueEventsTable.insert({
      ...event,
      amount: 99_000_000n,
      blockNumber: 90,
      blockHash: '0xlegacy',
      blockTime: new Date('2026-01-01T00:00:00Z'),
      extrinsicIndex: 4,
    });

    const records = await db.vaultRevenueEventsTable.fetchAll();
    expect(records).toHaveLength(4);
    expect(records.reduce((total, record) => total + record.amount, 0n)).toBe(139_000_000n);
    expect(records[0]).toMatchObject({
      amount: 99_000_000n,
      blockTime: new Date('2026-01-01T00:00:00Z'),
      extrinsicIndex: 4,
    });
    expect(records[1]).toMatchObject({
      amount: 25_000_000n,
      blockHash: '0xcanonical101',
      extrinsicIndex: 2,
    });
    expect(records.slice(2)).toMatchObject([
      { amount: 7_000_000n, source: 'vaultBurn', blockNumber: 102 },
      { amount: 8_000_000n, source: 'vaultBurn', blockNumber: 102 },
    ]);
  });
});
