import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getClient } from '@argonprotocol/mainchain';
import { AccountActivityIndexer } from '../../indexer/src/AccountActivityIndexer.ts';
import { IncompatibleAccountActivityDatabaseError, IndexerDb } from '../../indexer/src/IndexerDb.ts';

const mainnetRpc = 'https://rpc.argon.network';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.RECOVERY_SEED_CAPTURE !== '1') return;

  const databasePath = Path.resolve(import.meta.dirname, '../../indexer/seeds/mainnet-activity-v2.db');
  const captureDirectory = await mkdtemp(Path.join(Path.dirname(databasePath), '.recovery-capture-'));
  const captureDatabasePath = Path.join(captureDirectory, Path.basename(databasePath));

  try {
    await copyFile(databasePath, captureDatabasePath);

    const client = await getClient(mainnetRpc);
    let indexerDb: IndexerDb | undefined;
    try {
      try {
        indexerDb = new IndexerDb(captureDatabasePath);
      } catch (error) {
        if (!(error instanceof IncompatibleAccountActivityDatabaseError)) throw error;

        console.warn(`Rebuilding incompatible mainnet recovery seed: ${error.message}`);
        for (const suffix of ['', '-shm', '-wal']) await rm(`${captureDatabasePath}${suffix}`, { force: true });
        indexerDb = new IndexerDb(captureDatabasePath);
      }

      const indexer = new AccountActivityIndexer(indexerDb, mainnetRpc);
      const targetHeader = await indexer.start(client, { subscribe: false });
      await indexer.close({ drain: true });

      if (indexer.coverageGap) {
        throw new Error(`Unable to complete mainnet recovery seed: ${indexer.coverageGap.reason}`);
      }
      if (indexerDb.latestSyncedBlock !== targetHeader.blockNumber) {
        throw new Error(
          `Incomplete mainnet recovery seed: indexed ${indexerDb.latestSyncedBlock}, expected ${targetHeader.blockNumber}`,
        );
      }

      const targetHash = (await client.rpc.chain.getBlockHash(targetHeader.blockNumber)).toHex();
      if (targetHash.toLowerCase() !== targetHeader.blockHash.toLowerCase()) {
        throw new Error(
          `Mainnet recovery seed target block ${targetHeader.blockNumber} changed from ${targetHeader.blockHash} to ${targetHash}`,
        );
      }
    } finally {
      indexerDb?.close();
      await client.disconnect();
    }

    const database = new DatabaseSync(captureDatabasePath, { open: true });
    database.exec(`CREATE TABLE IF NOT EXISTS RecoveryStorage (
      blockNumber INTEGER NOT NULL REFERENCES Blocks(blockNumber),
      storageKey BLOB NOT NULL,
      storageValue BLOB,
      PRIMARY KEY (blockNumber, storageKey)
    ) WITHOUT ROWID`);
    database.exec(`CREATE TABLE IF NOT EXISTS RecoveryHeaders (
      blockNumber INTEGER PRIMARY KEY REFERENCES Blocks(blockNumber),
      blockTime INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      author TEXT NOT NULL,
      frameId INTEGER,
      frameRewardTicksRemaining INTEGER,
      isNewFrame INTEGER
    ) WITHOUT ROWID`);
    database.close();

    process.env.RECOVERY_SEED_PATH = captureDatabasePath;
  } catch (error) {
    await rm(captureDirectory, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    try {
      const captured = new DatabaseSync(captureDatabasePath, { open: true, readOnly: true });
      const count = captured.prepare('SELECT COUNT(*) AS count FROM RecoveryStorage').get() as { count: number };
      const latest = captured.prepare('SELECT MAX(blockNumber) AS blockNumber FROM Blocks').get() as {
        blockNumber: number;
      };
      const check = captured.prepare('PRAGMA quick_check').get() as { quick_check: string };
      captured.close();

      if (check.quick_check !== 'ok') {
        throw new Error(`Captured recovery seed failed integrity check: ${check.quick_check}`);
      }

      await rename(captureDatabasePath, databasePath);
      console.log(
        `Captured mainnet recovery seed through block ${latest.blockNumber} with ${count.count} historical storage values`,
      );
    } finally {
      delete process.env.RECOVERY_SEED_PATH;
      await rm(captureDirectory, { recursive: true, force: true });
    }
  };
}
