import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverFinancialHistoryReplayCapture } from './FinancialHistoryReplay.globalSetup.ts';

describe('FinancialHistoryReplay global setup', () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('recovers prior capture rows only for blocks whose hashes are unchanged', async () => {
    temporaryDirectory = await mkdtemp(Path.join(tmpdir(), 'financial-history-recovery-'));
    const currentPath = Path.join(temporaryDirectory, 'current.db');
    const previousPath = Path.join(temporaryDirectory, 'previous.db');
    const schema = `CREATE TABLE Blocks (
      blockNumber INTEGER PRIMARY KEY,
      blockHash BLOB NOT NULL
    );
    CREATE TABLE RecoveryStorage (
      blockNumber INTEGER NOT NULL,
      storageKey BLOB NOT NULL,
      storageValue BLOB,
      PRIMARY KEY (blockNumber, storageKey)
    ) WITHOUT ROWID;
    CREATE TABLE RecoveryStorageKeyEnumerations (
      blockNumber INTEGER NOT NULL,
      storagePrefix BLOB NOT NULL,
      PRIMARY KEY (blockNumber, storagePrefix)
    ) WITHOUT ROWID;
    CREATE TABLE RecoveryHeaders (
      blockNumber INTEGER PRIMARY KEY,
      blockTime INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      author TEXT NOT NULL,
      frameId INTEGER,
      frameRewardTicksRemaining INTEGER,
      isNewFrame INTEGER
    ) WITHOUT ROWID;`;

    const previous = new DatabaseSync(previousPath);
    previous.exec(schema);
    previous.prepare('INSERT INTO Blocks (blockNumber, blockHash) VALUES (?, ?)').run(1, Uint8Array.of(1));
    previous.prepare('INSERT INTO Blocks (blockNumber, blockHash) VALUES (?, ?)').run(2, Uint8Array.of(9));
    previous
      .prepare(
        `INSERT INTO RecoveryHeaders (
          blockNumber, blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 10, 11, 'matching', null, null, null);
    previous
      .prepare(
        `INSERT INTO RecoveryHeaders (
          blockNumber, blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(2, 20, 21, 'reorged', null, null, null);
    previous
      .prepare('INSERT INTO RecoveryStorage (blockNumber, storageKey, storageValue) VALUES (?, ?, ?)')
      .run(1, Uint8Array.of(10), Uint8Array.of(11));
    previous
      .prepare('INSERT INTO RecoveryStorage (blockNumber, storageKey, storageValue) VALUES (?, ?, ?)')
      .run(2, Uint8Array.of(20), Uint8Array.of(21));
    previous
      .prepare('INSERT INTO RecoveryStorageKeyEnumerations (blockNumber, storagePrefix) VALUES (?, ?)')
      .run(1, Uint8Array.of(30));
    previous
      .prepare('INSERT INTO RecoveryStorageKeyEnumerations (blockNumber, storagePrefix) VALUES (?, ?)')
      .run(2, Uint8Array.of(31));
    previous.close();

    const current = new DatabaseSync(currentPath);
    try {
      current.exec(schema);
      current.prepare('INSERT INTO Blocks (blockNumber, blockHash) VALUES (?, ?)').run(1, Uint8Array.of(1));
      current.prepare('INSERT INTO Blocks (blockNumber, blockHash) VALUES (?, ?)').run(2, Uint8Array.of(2));

      recoverFinancialHistoryReplayCapture(current, previousPath);

      expect(current.prepare('SELECT blockNumber, author FROM RecoveryHeaders ORDER BY blockNumber').all()).toEqual([
        { blockNumber: 1, author: 'matching' },
      ]);
      expect(
        current
          .prepare(
            'SELECT blockNumber, hex(storageKey) AS storageKey, hex(storageValue) AS storageValue FROM RecoveryStorage ORDER BY blockNumber',
          )
          .all(),
      ).toEqual([{ blockNumber: 1, storageKey: '0A', storageValue: '0B' }]);
      expect(
        current
          .prepare(
            'SELECT blockNumber, hex(storagePrefix) AS storagePrefix FROM RecoveryStorageKeyEnumerations ORDER BY blockNumber',
          )
          .all(),
      ).toEqual([{ blockNumber: 1, storagePrefix: '1E' }]);
    } finally {
      current.close();
    }
  });
});
