import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';
import { TestSqliteDb } from './helpers/db.ts';

const MIGRATIONS_DIR = Path.resolve(__dirname, '../../src-tauri/migrations');

describe('28-bitcoin-reused-hd-path migration', () => {
  it('allows historical locks to share an owner key while keeping pending locks unique', async () => {
    const db = new TestSqliteDb(':memory:');

    try {
      const migrationDirs = (await readdir(MIGRATIONS_DIR)).sort();
      for (const migrationDir of migrationDirs.filter(x => x < '28-bitcoin-reused-hd-path')) {
        await db.exec(await readFile(Path.join(MIGRATIONS_DIR, migrationDir, 'up.sql'), 'utf8'));
      }

      const insertLock = async (uuid: string, utxoId: number) => {
        await db.run(
          `INSERT INTO BitcoinLocks (uuid, status, utxoId, satoshis, cosignVersion, network, hdPath, vaultId)
           VALUES (?, 'Released', ?, 10000, 'v1', 'bitcoin', ?, 17)`,
          [uuid, utxoId, "m/1018'/0'/17'/0/1'"],
        );
      };

      await insertLock('old-lock', 26);
      await expect(insertLock('current-lock', 41)).rejects.toThrow();

      await db.exec(await readFile(Path.join(MIGRATIONS_DIR, '28-bitcoin-reused-hd-path', 'up.sql'), 'utf8'));
      await insertLock('current-lock', 41);

      const locks = await db.all<{ uuid: string; utxoId: number }[]>(
        'SELECT uuid, utxoId FROM BitcoinLocks ORDER BY utxoId',
      );
      expect(locks).toEqual([
        { uuid: 'old-lock', utxoId: 26 },
        { uuid: 'current-lock', utxoId: 41 },
      ]);

      const insertPendingLock = async (uuid: string) => {
        await db.run(
          `INSERT INTO BitcoinLocks (uuid, status, satoshis, cosignVersion, network, hdPath, vaultId)
           VALUES (?, 'LockIsProcessingOnArgon', 10000, 'v1', 'bitcoin', ?, 17)`,
          [uuid, "m/1018'/0'/17'/0/2'"],
        );
      };

      await insertPendingLock('pending-lock');
      await expect(insertPendingLock('duplicate-pending-lock')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
