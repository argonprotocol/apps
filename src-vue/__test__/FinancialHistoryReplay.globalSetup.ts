import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexerDb } from '../../indexer/src/IndexerDb.ts';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.FINANCIAL_HISTORY_REPLAY_CAPTURE !== '1') return;

  const seedDirectory = Path.resolve(import.meta.dirname, '../../indexer/seeds');
  const replayDatabasePath = Path.join(seedDirectory, 'mainnet-financial-history-replay.db');
  const activityDatabasePath = Path.join(seedDirectory, 'mainnet-activity-v2.db');
  if (!existsSync(activityDatabasePath)) {
    throw new Error('Financial history replay capture requires a mainnet activity seed from the indexer');
  }

  const captureDirectory = await mkdtemp(Path.join(seedDirectory, '.financial-history-replay-'));
  const captureDatabasePath = Path.join(captureDirectory, Path.basename(replayDatabasePath));

  try {
    await copyFile(activityDatabasePath, captureDatabasePath);

    const indexerDatabase = new IndexerDb(captureDatabasePath);
    try {
      if (!indexerDatabase.latestSyncedBlock) throw new Error('Mainnet indexer seed has no captured blocks');
    } finally {
      indexerDatabase.close();
    }

    const database = new DatabaseSync(captureDatabasePath, { open: true });
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS RecoveryStorage (
        blockNumber INTEGER NOT NULL REFERENCES Blocks(blockNumber),
        storageKey BLOB NOT NULL,
        storageValue BLOB,
        PRIMARY KEY (blockNumber, storageKey)
      ) WITHOUT ROWID`);
      database.exec(`CREATE TABLE IF NOT EXISTS RecoveryStorageKeyEnumerations (
        blockNumber INTEGER NOT NULL REFERENCES Blocks(blockNumber),
        storagePrefix BLOB NOT NULL,
        PRIMARY KEY (blockNumber, storagePrefix)
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

      if (existsSync(replayDatabasePath)) {
        recoverFinancialHistoryReplayCapture(database, replayDatabasePath);
      }
    } finally {
      database.close();
    }

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

export function recoverFinancialHistoryReplayCapture(database: DatabaseSync, replayDatabasePath: string): void {
  database.prepare('ATTACH DATABASE ? AS PreviousReplay').run(replayDatabasePath);
  const recoveredHeaders = database
    .prepare(
      `
      INSERT OR IGNORE INTO RecoveryHeaders (
        blockNumber, blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
      )
      SELECT previousHeader.blockNumber,
             previousHeader.blockTime,
             previousHeader.tick,
             previousHeader.author,
             previousHeader.frameId,
             previousHeader.frameRewardTicksRemaining,
             previousHeader.isNewFrame
      FROM PreviousReplay.RecoveryHeaders previousHeader
      JOIN PreviousReplay.Blocks previousBlock ON previousBlock.blockNumber = previousHeader.blockNumber
      JOIN main.Blocks currentBlock
        ON currentBlock.blockNumber = previousBlock.blockNumber
       AND currentBlock.blockHash = previousBlock.blockHash
    `,
    )
    .run().changes;
  const recoveredStorage = database
    .prepare(
      `
      INSERT OR IGNORE INTO RecoveryStorage (blockNumber, storageKey, storageValue)
      SELECT previousStorage.blockNumber, previousStorage.storageKey, previousStorage.storageValue
      FROM PreviousReplay.RecoveryStorage previousStorage
      JOIN PreviousReplay.Blocks previousBlock ON previousBlock.blockNumber = previousStorage.blockNumber
      JOIN main.Blocks currentBlock
        ON currentBlock.blockNumber = previousBlock.blockNumber
       AND currentBlock.blockHash = previousBlock.blockHash
    `,
    )
    .run().changes;
  const recoveredStorageKeyEnumerations = database
    .prepare(
      `
      INSERT OR IGNORE INTO RecoveryStorageKeyEnumerations (blockNumber, storagePrefix)
      SELECT previousEnumeration.blockNumber, previousEnumeration.storagePrefix
      FROM PreviousReplay.RecoveryStorageKeyEnumerations previousEnumeration
      JOIN PreviousReplay.Blocks previousBlock ON previousBlock.blockNumber = previousEnumeration.blockNumber
      JOIN main.Blocks currentBlock
        ON currentBlock.blockNumber = previousBlock.blockNumber
       AND currentBlock.blockHash = previousBlock.blockHash
    `,
    )
    .run().changes;
  console.log(
    `Recovered ${recoveredHeaders} headers, ${recoveredStorage} storage values, and ${recoveredStorageKeyEnumerations} key enumerations from the prior corpus`,
  );
}
