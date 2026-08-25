import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getClient } from '@argonprotocol/mainchain';
import { AccountActivityIndexer } from '../../indexer/src/AccountActivityIndexer.ts';
import {
  IncompatibleAccountActivityDatabaseError,
  IndexerDb,
  upgradeAccountActivitySeedFromV2,
} from '../../indexer/src/IndexerDb.ts';

const mainnetRpc = 'https://rpc.argon.network';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.FINANCIAL_HISTORY_REPLAY_CAPTURE !== '1') return;

  const seedDirectory = Path.resolve(import.meta.dirname, '../../indexer/seeds');
  const replayDatabasePath = Path.join(seedDirectory, 'mainnet-financial-history-replay.db');
  const activityDatabasePath = Path.join(seedDirectory, 'mainnet-activity-v2.db');
  const sourceDatabasePath = existsSync(replayDatabasePath) ? replayDatabasePath : activityDatabasePath;
  if (!existsSync(sourceDatabasePath)) {
    throw new Error('Financial history replay capture requires an existing replay corpus or mainnet activity seed');
  }

  const captureDirectory = await mkdtemp(Path.join(seedDirectory, '.financial-history-replay-'));
  const captureDatabasePath = Path.join(captureDirectory, Path.basename(replayDatabasePath));

  try {
    await copyFile(sourceDatabasePath, captureDatabasePath);
    const copiedSeed = new DatabaseSync(captureDatabasePath, { open: true });
    try {
      const sync = copiedSeed.prepare(`SELECT definitionVersion FROM SyncState WHERE id = 'accountActivity'`).get() as
        | { definitionVersion: number }
        | undefined;
      if (sync?.definitionVersion === 2) {
        copiedSeed.exec('DROP TABLE IF EXISTS RecoveryStorage; DROP TABLE IF EXISTS RecoveryHeaders;');
      }
    } finally {
      copiedSeed.close();
    }

    if (upgradeAccountActivitySeedFromV2(captureDatabasePath)) {
      console.log('Upgraded mainnet replay corpus to account activity definition 3; replaying runtime spec 158');
    }

    const client = await getClient(mainnetRpc);
    let indexerDb: IndexerDb | undefined;
    try {
      try {
        indexerDb = new IndexerDb(captureDatabasePath);
      } catch (error) {
        if (!(error instanceof IncompatibleAccountActivityDatabaseError)) throw error;

        console.warn(`Rebuilding incompatible mainnet replay corpus: ${error.message}`);
        for (const suffix of ['', '-shm', '-wal']) await rm(`${captureDatabasePath}${suffix}`, { force: true });
        indexerDb = new IndexerDb(captureDatabasePath);
      }

      const indexer = new AccountActivityIndexer(indexerDb, mainnetRpc);
      const targetHeader = await indexer.start(client, { subscribe: false });
      await indexer.close({ drain: true });

      if (indexer.coverageGap) {
        throw new Error(`Unable to complete mainnet replay corpus: ${indexer.coverageGap.reason}`);
      }
      if (indexerDb.latestSyncedBlock !== targetHeader.blockNumber) {
        throw new Error(
          `Incomplete mainnet replay corpus: indexed ${indexerDb.latestSyncedBlock}, expected ${targetHeader.blockNumber}`,
        );
      }

      const targetHash = (await client.rpc.chain.getBlockHash(targetHeader.blockNumber)).toHex();
      if (targetHash.toLowerCase() !== targetHeader.blockHash.toLowerCase()) {
        throw new Error(
          `Mainnet replay corpus target block ${targetHeader.blockNumber} changed from ${targetHeader.blockHash} to ${targetHash}`,
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

    process.env.FINANCIAL_HISTORY_REPLAY_PATH = captureDatabasePath;
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
        throw new Error(`Captured replay corpus failed integrity check: ${check.quick_check}`);
      }

      await rename(captureDatabasePath, replayDatabasePath);
      console.log(
        `Captured mainnet financial history replay corpus through block ${latest.blockNumber} with ${count.count} historical storage values`,
      );
    } finally {
      delete process.env.FINANCIAL_HISTORY_REPLAY_PATH;
      await rm(captureDirectory, { recursive: true, force: true });
    }
  };
}
