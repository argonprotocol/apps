import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type ArgonClient, getOfflineRegistry } from '@argonprotocol/mainchain';
import { Metadata } from '@polkadot/types/metadata';
import { decorateStorage } from '@polkadot/types/metadata/decorate/storage';
import { compactStripLength, hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapturedHistoryReader } from './CapturedHistoryReader.ts';

const registry = getOfflineRegistry();
const runtimeMetadata = u8aConcat(hexToU8a('0x6d65746110'), registry.metadata.toU8a());
const metadata = new Metadata(registry, runtimeMetadata);
const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
const blockHash = `0x${'01'.repeat(32)}`;
const cachedHash = `0x${'11'.repeat(32)}`;
const liveHash = `0x${'22'.repeat(32)}`;

describe('CapturedHistoryReader storage capture', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let database: DatabaseSync;
  let reader: CapturedHistoryReader;
  let clientAt: ReturnType<typeof vi.fn>;
  let queryStorageAt: ReturnType<typeof vi.fn>;
  let liveQuery: ReturnType<typeof vi.fn>;
  let liveMulti: ReturnType<typeof vi.fn>;
  let liveKeys: ReturnType<typeof vi.fn>;
  let cachedStorageKey: string;
  let missingStorageKey: string;
  let storagePrefix: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(Path.join(tmpdir(), 'captured-history-reader-'));
    databasePath = Path.join(temporaryDirectory, 'capture.db');
    database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE Blocks (
      blockNumber INTEGER PRIMARY KEY,
      blockHash BLOB NOT NULL,
      specVersion INTEGER NOT NULL
    );
    CREATE TABLE RuntimeMetadata (
      specVersion INTEGER PRIMARY KEY,
      blockHash BLOB NOT NULL,
      metadata BLOB NOT NULL
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
    ) WITHOUT ROWID;`);
    database
      .prepare('INSERT INTO Blocks (blockNumber, blockHash, specVersion) VALUES (?, ?, ?)')
      .run(1, hexToU8a(blockHash), 1);
    database
      .prepare('INSERT INTO RuntimeMetadata (specVersion, blockHash, metadata) VALUES (?, ?, ?)')
      .run(1, hexToU8a(blockHash), runtimeMetadata);
    database
      .prepare(
        `INSERT INTO RecoveryHeaders (
          blockNumber, blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1_000, 1, 'author', null, null, null);

    const blockHashStorage = storage.system.blockHash;
    cachedStorageKey = u8aToHex(compactStripLength(blockHashStorage(1))[1]);
    missingStorageKey = u8aToHex(compactStripLength(blockHashStorage(2))[1]);
    storagePrefix = u8aToHex(blockHashStorage.keyPrefix());
    liveQuery = vi.fn(async (blockNumber: number) => {
      const value = blockNumber === 1 ? `0x${'aa'.repeat(32)}` : liveHash;
      return registry.createType('H256', value);
    });
    liveMulti = vi.fn(async (blockNumbers: number[]) => {
      return blockNumbers.map(blockNumber => {
        const value = blockNumber === 1 ? `0x${'aa'.repeat(32)}` : liveHash;
        return registry.createType('H256', value);
      });
    });
    liveKeys = vi.fn(async () => []);
    const liveStorageEntry = Object.assign(liveQuery, {
      key: (blockNumber: number) => (blockNumber === 1 ? cachedStorageKey : missingStorageKey),
      keyPrefix: () => u8aToHex(blockHashStorage.keyPrefix()),
      keys: liveKeys,
      multi: liveMulti,
    });
    queryStorageAt = vi.fn(async (keys: string[]) => {
      return keys.map(key => {
        const value = key === missingStorageKey ? liveHash : `0x${'aa'.repeat(32)}`;
        return registry.createType('Bytes', value);
      });
    });
    clientAt = vi.fn(async () => ({
      query: { system: { blockHash: liveStorageEntry } },
      runtimeVersion: { specVersion: registry.createType('u32', 1) },
    }));
    const client = {
      at: clientAt,
      rpc: {
        chain: { getHeader: vi.fn() },
        state: { queryStorageAt },
      },
    } as unknown as ArgonClient;
    reader = new CapturedHistoryReader(databasePath, client);
  });

  afterEach(async () => {
    reader.close();
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('reuses direct storage and fetches only missing values in a multi query', async () => {
    database
      .prepare('INSERT INTO RecoveryStorage (blockNumber, storageKey, storageValue) VALUES (?, ?, ?)')
      .run(1, hexToU8a(cachedStorageKey), hexToU8a(cachedHash));
    const api = await reader.getApi({ blockNumber: 1, blockHash });

    const direct = await api.query.system.blockHash(1);

    expect(direct).toBe(cachedHash);
    expect(liveQuery).not.toHaveBeenCalled();
    expect(queryStorageAt).not.toHaveBeenCalled();

    const multiple = await api.query.system.blockHash.multi([1, 2]);

    expect(multiple).toEqual([cachedHash, liveHash]);
    expect(liveMulti).not.toHaveBeenCalled();
    expect(queryStorageAt).toHaveBeenCalledOnce();
    expect(queryStorageAt).toHaveBeenCalledWith([missingStorageKey], blockHash);

    const captured = await api.query.system.blockHash(2);

    expect(captured).toBe(liveHash);
    expect(queryStorageAt).toHaveBeenCalledOnce();
    expect(clientAt).not.toHaveBeenCalled();
  });

  it('builds storage keys from captured runtime metadata', async () => {
    const api = await reader.getApi({ blockNumber: 1, blockHash });

    expect(api.query.system.blockHash.key(1)).toBe(cachedStorageKey);
    expect(api.query.system.blockHash.keyPrefix()).toBe(storagePrefix);
    expect(clientAt).not.toHaveBeenCalled();
  });

  it('records and reuses a completed empty storage-key enumeration', async () => {
    const api = await reader.getApi({ blockNumber: 1, blockHash });

    const firstKeys = await api.query.system.blockHash.keys();
    const secondKeys = await api.query.system.blockHash.keys();

    expect(firstKeys).toEqual([]);
    expect(secondKeys).toEqual([]);
    expect(clientAt).toHaveBeenCalledOnce();
    expect(liveKeys).toHaveBeenCalledOnce();
    expect(queryStorageAt).not.toHaveBeenCalled();
  });
});
