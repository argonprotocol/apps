import { describe, expect, it } from 'vitest';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';

describe('43-remove-stable-swaps migration', () => {
  it('removes existing swap history while preserving unrelated configuration', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(42);
    try {
      await db.execute(
        'INSERT INTO StableSwapSyncState (walletAddress, startBlockNumber, lastScannedBlockNumber) VALUES (?, ?, ?)',
        ['0xsynthetic', 1, 2],
      );
      await db.execute('INSERT INTO Config (key, value) VALUES (?, ?)', ['synthetic-preserved-setting', 'true']);
      const configBefore = await db.select('SELECT * FROM Config');
      await migrateToLatest();
      expect(await db.select("SELECT name FROM sqlite_master WHERE name LIKE 'StableSwap%'")).toEqual([]);
      expect(await db.select('SELECT * FROM Config')).toEqual(configBefore);
    } finally {
      await db.close();
    }
  });

  it('starts a fresh database without swap tables', async () => {
    const db = await createTestDb();
    try {
      expect(await db.select("SELECT name FROM sqlite_master WHERE name LIKE 'StableSwap%'")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
