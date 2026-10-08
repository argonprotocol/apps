import type { IBlockHeaderInfo, RuntimeSystemEventRecord } from '@argonprotocol/apps-core';
import { describe, expect, it } from 'vitest';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { createTestDbAtMigration } from './helpers/db.ts';

describe('VaultRevenueEventsTable', () => {
  it('preserves old collections and distinct frame burns without duplicating replayed revenue', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(35);
    await db.execute(
      `INSERT INTO VaultRevenueEvents (amount, source, blockNumber, blockHash)
       VALUES (?, ?, ?, ?)`,
      ['99000000', 'vaultCollect', 90, '0xlegacy'],
    );
    await migrateToLatest();
    expect(await db.vaultRevenueEventsTable.fetchAll()).toEqual([
      expect.objectContaining({ amount: 99_000_000n, source: 'vaultCollect', blockNumber: 90 }),
    ]);
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

    const accountId = `0x${'11'.repeat(32)}`;
    const history = new VaultHistory(Promise.resolve(db), accountId);
    const burnBlock: IBlockHeaderInfo = {
      isFinalized: true,
      blockNumber: 102,
      blockHash: '0xblock102',
      parentHash: '0xcanonical101',
      blockTime: Date.UTC(2026, 0, 2),
      author: accountId,
      tick: 102,
      frameId: 12,
    };
    // The runtime identifies expired revenue by frame, even when amounts match.
    const burns: RuntimeSystemEventRecord[] = [1, 2].map(frameId => ({
      event: {
        section: 'vaults',
        method: 'VaultRevenueUncollected',
        data: { vaultId: 7, frameId, amount: 7_000_000n },
      },
      phase: { type: 'Initialization' },
      topics: [],
    }));
    await history.recordFinalizedRevenue(burnBlock, burns, 7, 159);
    expect(db.vaultRevenueEventsTable.revision).toBe(4);

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
    expect(records.reduce((total, record) => total + record.amount, 0n)).toBe(138_000_000n);
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
      { amount: 7_000_000n, source: 'vaultBurn', blockNumber: 102, frameId: 1 },
      { amount: 7_000_000n, source: 'vaultBurn', blockNumber: 102, frameId: 2 },
    ]);

    const revisionBeforeReplay = db.vaultRevenueEventsTable.revision;
    const restarted = new VaultHistory(Promise.resolve(db), accountId);
    await restarted.recordFinalizedRevenue(burnBlock, burns, 7, 159);
    expect(await db.vaultRevenueEventsTable.fetchAll()).toEqual(records);
    expect(db.vaultRevenueEventsTable.revision).toBe(revisionBeforeReplay);
    await db.close();
  });
});
