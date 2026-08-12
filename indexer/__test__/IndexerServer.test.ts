import fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { AccountActivityKind } from '../src/AccountActivity.ts';
import { IndexerDb } from '../src/IndexerDb.ts';
import { openAccountActivityDatabase } from '../src/IndexerServer.ts';

it('replaces an incompatible persisted activity database', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-server-'));
  const file = 'unseeded-test-activity-v2.db';
  const databasePath = Path.join(directory, file);
  const oldDb = new IndexerDb(databasePath);

  oldDb.recordBlocks([
    {
      blockNumber: 1,
      blockHash: Uint8Array.of(1),
      specVersion: 156,
      accounts: [{ address: 'old-account', mask: AccountActivityKind.Transfer }],
      vaults: [],
      vaultOwners: [],
    },
  ]);
  oldDb.close();

  const rawDb = new DatabaseSync(databasePath);
  rawDb.prepare(`UPDATE SyncState SET definitionVersion = 0 WHERE id = 'accountActivity'`).run();
  rawDb.close();

  try {
    const replacement = openAccountActivityDatabase(directory, file);
    expect(replacement.latestSyncedBlock).toBe(0);
    expect(replacement.findAddressActivity('old-account')).toEqual([]);
    replacement.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
