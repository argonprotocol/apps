import { describe, expect, it } from 'vitest';
import { open } from 'sqlite';
import { Database as Sqlite3Database } from 'sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';

const MIGRATIONS_DIR = Path.resolve(__dirname, '../../src-tauri/migrations');

describe('12-bitcoin-utxo-foundation migration', () => {
  it('keeps pending funding rows, backfills candidate history, and only links accepted funding pointers', async () => {
    const db = await open({
      filename: ':memory:',
      driver: Sqlite3Database,
    });

    try {
      const migrationDirs = await listMigrationDirs();
      for (const migrationDir of migrationDirs.filter(x => x < '12-bitcoin-utxo-foundation')) {
        await runMigration(db, migrationDir);
      }

      await db.run(
        `INSERT INTO BitcoinLocks (
          uuid,
          status,
          utxoId,
          satoshis,
          cosignVersion,
          lockDetails,
          lockMempool,
          network,
          hdPath,
          vaultId,
          createdAt,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'pending-lock',
          'LockReadyForBitcoin',
          42,
          10_500,
          'V1',
          JSON.stringify({ createdAtHeight: 800_000, p2wshScriptHashHex: '0014abcd' }),
          JSON.stringify({
            txid: 'mempooltx',
            vout: 2,
            satoshis: 10_499,
            transactionBlockHeight: 805_000,
            transactionBlockTime: 1_700_000_000,
            argonBitcoinHeight: 805_010,
          }),
          'bitcoin',
          "m/1018'/0'/1'/0/0'",
          1,
          '2026-01-01T00:00:00Z',
          '2026-01-01T00:00:30Z',
        ],
      );

      await db.run(
        `INSERT INTO BitcoinLockStatusHistory (uuid, newStatus, createdAt)
         VALUES (?, ?, ?), (?, ?, ?)`,
        [
          'pending-lock',
          'LockIsProcessingOnArgon',
          '2026-01-01T00:00:00Z',
          'pending-lock',
          'LockReadyForBitcoin',
          '2026-01-01T00:01:00Z',
        ],
      );

      await db.run(
        `INSERT INTO BitcoinLocks (
          uuid,
          status,
          utxoId,
          satoshis,
          lockedUtxoSatoshis,
          lockedTxid,
          lockedVout,
          cosignVersion,
          lockDetails,
          network,
          hdPath,
          vaultId,
          createdAt,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'locked-lock',
          'LockedAndMinted',
          43,
          20_000,
          19_995,
          'acceptedtx',
          1,
          'V1',
          JSON.stringify({ createdAtHeight: 801_000, p2wshScriptHashHex: '0014dcba' }),
          'bitcoin',
          "m/1018'/0'/1'/0/1'",
          1,
          '2026-01-02T00:00:00Z',
          '2026-01-02T00:00:30Z',
        ],
      );

      await runMigration(db, '12-bitcoin-utxo-foundation');

      const pendingUtxo = await db.get<{
        id: number;
        txid: string;
        vout: number;
        status: string;
        firstSeenBitcoinHeight: number;
        firstSeenOracleHeight: number;
      }>('SELECT * FROM BitcoinUtxos WHERE lockUtxoId = ?', [42]);
      expect(pendingUtxo).toBeTruthy();
      expect(pendingUtxo?.txid).toBe('mempooltx');
      expect(pendingUtxo?.vout).toBe(2);
      expect(pendingUtxo?.status).toBe('FundingCandidate');
      expect(pendingUtxo?.firstSeenBitcoinHeight).toBe(805_000);
      expect(pendingUtxo?.firstSeenOracleHeight).toBe(805_010);

      const pendingLock = await db.get<{ fundingUtxoRecordId: number | null }>(
        'SELECT fundingUtxoRecordId FROM BitcoinLocks WHERE uuid = ?',
        ['pending-lock'],
      );
      expect(pendingLock?.fundingUtxoRecordId).toBeNull();

      const pendingHistory = await db.all<{ newStatus: string }[]>(
        `SELECT newStatus
         FROM BitcoinUtxoStatusHistory
         WHERE utxoRecordId = ?
         ORDER BY createdAt ASC, id ASC`,
        [pendingUtxo?.id],
      );
      expect(pendingHistory.map(x => x.newStatus)).toContain('FundingCandidate');
      expect(pendingHistory.map(x => x.newStatus)).not.toContain('FundingUtxo');

      const lockedLock = await db.get<{ fundingUtxoRecordId: number | null }>(
        'SELECT fundingUtxoRecordId FROM BitcoinLocks WHERE uuid = ?',
        ['locked-lock'],
      );
      expect(lockedLock?.fundingUtxoRecordId).not.toBeNull();

      const linkedFundingRecord = await db.get<{ txid: string; vout: number; status: string }>(
        'SELECT txid, vout, status FROM BitcoinUtxos WHERE id = ?',
        [lockedLock?.fundingUtxoRecordId],
      );
      expect(linkedFundingRecord?.txid).toBe('acceptedtx');
      expect(linkedFundingRecord?.vout).toBe(1);
      expect(linkedFundingRecord?.status).toBe('FundingUtxo');
    } finally {
      await db.close();
    }
  });
});

async function listMigrationDirs(): Promise<string[]> {
  const dirs = await readdir(MIGRATIONS_DIR);
  return dirs.sort();
}

async function runMigration(db: { exec: (sql: string) => Promise<unknown> }, migrationDir: string): Promise<void> {
  const migrationFile = Path.join(MIGRATIONS_DIR, migrationDir, 'up.sql');
  const migrationSql = await readFile(migrationFile, 'utf8');
  await db.exec(migrationSql);
}
