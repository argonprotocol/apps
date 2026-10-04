import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createFinancialHistoryReplayTables, recoverFinancialHistoryReplayCapture } from './FinancialHistoryReplay.ts';

describe('Financial history replay capture', () => {
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
    );`;

    const previous = new DatabaseSync(previousPath);
    previous.exec(schema);
    createFinancialHistoryReplayTables(previous);
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
      createFinancialHistoryReplayTables(current);
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
