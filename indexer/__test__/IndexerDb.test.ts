import fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { encodeAddress } from '@argonprotocol/mainchain';
import { AccountActivityKind } from '../src/AccountActivity.ts';
import { IncompatibleAccountActivityDatabaseError, IndexerDb } from '../src/IndexerDb.ts';

const alice = encodeAddress(new Uint8Array(32).fill(1));

it('combines direct and cached vault activity into one account-block row', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));

  try {
    db.recordBlocks([
      {
        blockNumber: 1,
        blockHash: Uint8Array.of(1),
        specVersion: 156,
        accounts: [{ address: alice, mask: AccountActivityKind.Transfer }],
        vaults: [{ vaultId: 7, mask: AccountActivityKind.VaultPosition }],
        vaultOwners: [{ vaultId: 7, address: alice }],
      },
      {
        blockNumber: 2,
        blockHash: Uint8Array.of(2),
        specVersion: 156,
        accounts: [],
        vaults: [{ vaultId: 7, mask: AccountActivityKind.VaultRevenue }],
        vaultOwners: [],
      },
    ]);

    expect(db.findAddressActivity(alice)).toMatchObject([
      {
        blockNumber: 1,
        activityMask: AccountActivityKind.Transfer | AccountActivityKind.VaultPosition,
      },
      { blockNumber: 2, activityMask: AccountActivityKind.VaultRevenue },
    ]);
    expect(
      db.findAddressActivity(alice, {
        afterBlock: 1,
        activityMask: AccountActivityKind.VaultRevenue,
      }),
    ).toMatchObject([{ blockNumber: 2, activityMask: AccountActivityKind.VaultRevenue }]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('associates ownerless Bitcoin lifecycle blocks with the recorded lock owner', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));

  try {
    db.recordBlocks([
      {
        blockNumber: 1,
        blockHash: Uint8Array.of(1),
        specVersion: 156,
        accounts: [{ address: alice, mask: AccountActivityKind.BitcoinLock }],
        vaults: [],
        vaultOwners: [],
        bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
        bitcoinLockOwners: [{ utxoId: 9, address: alice }],
      },
      {
        blockNumber: 2,
        blockHash: Uint8Array.of(2),
        specVersion: 156,
        accounts: [],
        vaults: [],
        vaultOwners: [],
        bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
        bitcoinLockOwners: [],
      },
    ]);

    expect(db.findAddressActivity(alice)).toMatchObject([
      { blockNumber: 1, activityMask: AccountActivityKind.BitcoinLock },
      { blockNumber: 2, activityMask: AccountActivityKind.BitcoinLock },
    ]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects account-owned Bitcoin lifecycle activity when replay has not established its owner', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));

  try {
    expect(() =>
      db.recordBlocks([
        {
          blockNumber: 1,
          blockHash: Uint8Array.of(1),
          specVersion: 156,
          accounts: [],
          vaults: [],
          vaultOwners: [],
          bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
          bitcoinLockOwners: [],
        },
      ]),
    ).toThrow('Bitcoin lock 9 has activity before its owner is known');
    expect(db.latestSyncedBlock).toBe(0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects vault activity when replay has not established its owner', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));

  try {
    expect(() =>
      db.recordBlocks([
        {
          blockNumber: 1,
          blockHash: Uint8Array.of(1),
          specVersion: 156,
          accounts: [],
          vaults: [{ vaultId: 7, mask: AccountActivityKind.VaultRevenue }],
          vaultOwners: [],
        },
      ]),
    ).toThrow('Vault 7 has activity before its owner is known');
    expect(db.latestSyncedBlock).toBe(0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('refuses to resume an existing index with a different activity definition', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const databasePath = Path.join(directory, 'test.db');
  const db = new IndexerDb(databasePath);

  db.recordBlocks([
    {
      blockNumber: 1,
      blockHash: Uint8Array.of(1),
      specVersion: 156,
      accounts: [{ address: alice, mask: AccountActivityKind.Transfer }],
      vaults: [],
      vaultOwners: [],
    },
  ]);
  db.close();

  const rawDb = new DatabaseSync(databasePath);
  rawDb.prepare(`UPDATE SyncState SET definitionVersion = 0 WHERE id = 'accountActivity'`).run();
  rawDb.close();

  try {
    expect(() => new IndexerDb(databasePath)).toThrow(IncompatibleAccountActivityDatabaseError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('refuses to resume an incomplete development seed instead of silently omitting Bitcoin history', () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'account-activity-'));
  const databasePath = Path.join(directory, 'test.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE SchemaVersion (version INTEGER PRIMARY KEY);
    INSERT INTO SchemaVersion (version) VALUES (1);
    CREATE TABLE Blocks (blockNumber INTEGER PRIMARY KEY, blockHash BLOB NOT NULL, specVersion INTEGER NOT NULL);
    CREATE TABLE AccountBlocks (accountId TEXT NOT NULL, blockNumber INTEGER NOT NULL, activityMask INTEGER NOT NULL);
    CREATE TABLE VaultOwners (vaultId INTEGER PRIMARY KEY, accountId TEXT NOT NULL);
    CREATE TABLE ActivityKinds (bit INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE SyncState (
      id TEXT PRIMARY KEY,
      blockNumber INTEGER NOT NULL,
      definitionVersion INTEGER NOT NULL
    );
  `);
  database.close();

  try {
    expect(() => new IndexerDb(databasePath)).toThrow(
      'missing BitcoinLockOwners; replace or rebuild the account activity database',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
