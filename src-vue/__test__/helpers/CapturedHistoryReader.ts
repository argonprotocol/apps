import { DatabaseSync } from 'node:sqlite';
import type { ArgonClient, Codec, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import {
  AccountActivityKind,
  BlockWatch,
  type IAccountActivityQuery,
  type IBlockHeaderInfo,
  type IIndexerSpec,
} from '@argonprotocol/apps-core';
import { TypeRegistry } from '@polkadot/types/create';
import type { QueryableModuleStorage, QueryableStorageEntry } from '@polkadot/api-base/types/storage';
import { decorateStorage } from '@polkadot/types/metadata/decorate/storage';
import { Metadata } from '@polkadot/types/metadata';
import { StorageKey } from '@polkadot/types/primitive';
import { unwrapStorageSi } from '@polkadot/types/util';
import type { StorageEntry } from '@polkadot/types/primitive/types';
import type { Vec } from '@polkadot/types-codec';
import { compactStripLength, hexToU8a, u8aToHex } from '@polkadot/util';

type IIndexedActivityBlock = IIndexerSpec['/v2/activity/:address']['responseType']['blocks'][number];

export class CapturedHistoryReader {
  private readonly database: DatabaseSync;
  private readonly runtimes = new Map<
    number,
    { registry: TypeRegistry; specVersion: number; storage: ReturnType<typeof decorateStorage> }
  >();
  private readonly hasRecoveryStorage: boolean;
  private readonly hasRecoveryHeaders: boolean;

  constructor(
    databasePath: string,
    private readonly recordingClient?: ArgonClient,
  ) {
    this.database = new DatabaseSync(databasePath, { open: true, readOnly: !recordingClient });
    this.hasRecoveryStorage = Boolean(
      this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'RecoveryStorage'`).get(),
    );
    this.hasRecoveryHeaders = Boolean(
      this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'RecoveryHeaders'`).get(),
    );
  }

  public findActivityBlocks(address: string, filters: IAccountActivityQuery = {}): IIndexedActivityBlock[] {
    const records = this.database
      .prepare(
        `SELECT blocks.blockNumber, blocks.blockHash, blocks.specVersion, accounts.activityMask
         FROM AccountBlocks accounts
         JOIN Blocks blocks ON blocks.blockNumber = accounts.blockNumber
         WHERE accounts.accountId = :address
           AND blocks.blockNumber > :afterBlock
           AND blocks.blockNumber <= :toBlock
           AND (accounts.activityMask & :activityMask) != 0
         ORDER BY blocks.blockNumber`,
      )
      .all({
        address,
        afterBlock: filters.afterBlock ?? 0,
        toBlock: filters.toBlock ?? Number.MAX_SAFE_INTEGER,
        activityMask: filters.activityMask ?? 0x7fffffff,
      }) as unknown as (Omit<IIndexedActivityBlock, 'blockHash'> & { blockHash: Uint8Array })[];

    return records.map(record => ({ ...record, blockHash: u8aToHex(record.blockHash) }));
  }

  public findVaultOwners(minimumSpecVersion: number): string[] {
    const records = this.database
      .prepare(
        `SELECT owners.accountId
         FROM VaultOwners owners
         JOIN AccountBlocks accounts ON accounts.accountId = owners.accountId
         JOIN Blocks blocks ON blocks.blockNumber = accounts.blockNumber
         WHERE (accounts.activityMask & :activityMask) != 0
         GROUP BY owners.accountId
         HAVING MIN(blocks.specVersion) >= :minimumSpecVersion
         ORDER BY owners.accountId`,
      )
      .all({
        activityMask: AccountActivityKind.VaultPosition | AccountActivityKind.VaultRevenue,
        minimumSpecVersion,
      }) as unknown as { accountId: string }[];

    return records.map(({ accountId }) => accountId);
  }

  public findBitcoinOwners(minimumSpecVersion: number): string[] {
    const records = this.database
      .prepare(
        `SELECT owners.accountId
         FROM BitcoinLockOwners owners
         JOIN AccountBlocks accounts ON accounts.accountId = owners.accountId
         JOIN Blocks blocks ON blocks.blockNumber = accounts.blockNumber
         WHERE (accounts.activityMask & :activityMask) != 0
         GROUP BY owners.accountId
         HAVING MAX(blocks.specVersion) >= :minimumSpecVersion
         ORDER BY owners.accountId`,
      )
      .all({
        activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
        minimumSpecVersion,
      }) as unknown as { accountId: string }[];

    return records.map(({ accountId }) => accountId);
  }

  public findBitcoinLockIds(accountId: string): number[] {
    const records = this.database
      .prepare('SELECT utxoId FROM BitcoinLockOwners WHERE accountId = ? ORDER BY utxoId')
      .all(accountId) as unknown as { utxoId: number }[];

    return records.map(({ utxoId }) => utxoId);
  }

  public async findBondOwners(minimumSpecVersion: number): Promise<string[]> {
    const records = this.database
      .prepare(
        `SELECT DISTINCT accounts.accountId
         FROM AccountBlocks accounts
         JOIN Blocks blocks ON blocks.blockNumber = accounts.blockNumber
         WHERE (accounts.activityMask & :activityMask) != 0
           AND blocks.specVersion >= :minimumSpecVersion`,
      )
      .all({
        activityMask: AccountActivityKind.BondPosition,
        minimumSpecVersion,
      }) as unknown as { accountId: string }[];
    const accountIds = new Set(records.map(({ accountId }) => accountId));

    const latestBlockNumber = this.latestBlockNumber;
    const latestBlock = await this.getHeader(latestBlockNumber);
    let activeBondKeys: StorageKey[];
    if (this.recordingClient) {
      const api = await this.getRecordingApi(latestBlock);
      const treasury = api.query.treasury as unknown as QueryableModuleStorage<'promise'>;
      activeBondKeys = await treasury.bondLotIdsByAccount.keys();
    } else {
      const runtime = this.getRuntime(latestBlockNumber);
      activeBondKeys = this.readStorageKeys(
        latestBlockNumber,
        runtime,
        runtime.storage.treasury.bondLotIdsByAccount,
        [],
      );
    }
    for (const key of activeBondKeys) accountIds.add(key.args[0].toString());

    return [...accountIds].sort();
  }

  public get latestBlockNumber(): number {
    return Number(this.database.prepare('SELECT MAX(blockNumber) AS blockNumber FROM Blocks').get()?.blockNumber ?? 0);
  }

  public close(): void {
    this.database.close();
  }

  public withBackgroundArchiveRead<T>(read: () => Promise<T>): Promise<T> {
    return read();
  }

  public async getHeader(
    block: number | Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>,
  ): Promise<IBlockHeaderInfo> {
    const blockNumber = typeof block === 'number' ? block : block.blockNumber;
    const record = this.database
      .prepare(
        `SELECT current.blockHash, parent.blockHash AS parentHash
         FROM Blocks current
         LEFT JOIN Blocks parent ON parent.blockNumber = current.blockNumber - 1
         WHERE current.blockNumber = ?`,
      )
      .get(blockNumber) as { blockHash: Uint8Array; parentHash?: Uint8Array } | undefined;
    if (!record) throw new Error(`Seed does not contain block ${blockNumber}`);

    const blockHash = u8aToHex(record.blockHash);
    if (typeof block !== 'number' && blockHash.toLowerCase() !== block.blockHash.toLowerCase()) {
      throw new Error(`Seed block ${blockNumber} hash does not match ${block.blockHash}`);
    }

    if (this.hasRecoveryHeaders) {
      const header = this.database
        .prepare(
          `SELECT blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
           FROM RecoveryHeaders
           WHERE blockNumber = ?`,
        )
        .get(blockNumber) as
        | {
            blockTime: number;
            tick: number;
            author: string;
            frameId: number | null;
            frameRewardTicksRemaining: number | null;
            isNewFrame: number | null;
          }
        | undefined;
      if (header) {
        return {
          isFinalized: true,
          blockNumber,
          blockHash,
          parentHash: record.parentHash ? u8aToHex(record.parentHash) : '0x',
          blockTime: header.blockTime,
          tick: header.tick,
          author: header.author,
          ...(header.frameId == null ? {} : { frameId: header.frameId }),
          ...(header.frameRewardTicksRemaining == null
            ? {}
            : { frameRewardTicksRemaining: header.frameRewardTicksRemaining }),
          ...(header.isNewFrame == null ? {} : { isNewFrame: Boolean(header.isNewFrame) }),
        };
      }
    }

    const runtime = this.getRuntime(blockNumber);
    const blockTime = this.hasRecoveryStorage
      ? this.readStorage(blockNumber, blockHash, runtime, runtime.storage.timestamp.now, [], false)
      : undefined;
    const tick = this.hasRecoveryStorage
      ? this.readStorage(blockNumber, blockHash, runtime, runtime.storage.ticks.currentTick, [], false)
      : undefined;

    return {
      isFinalized: true,
      blockNumber,
      blockHash,
      parentHash: record.parentHash ? u8aToHex(record.parentHash) : '0x',
      blockTime: Number(blockTime?.toString() ?? 0),
      author: '',
      tick: Number(tick?.toString() ?? 0),
    };
  }

  public async getParentHeader(
    block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash' | 'parentHash'>,
  ): Promise<IBlockHeaderInfo> {
    if (this.recordingClient) await this.recordHeader(block);

    const parent = await this.getHeader(block.blockNumber - 1);
    if (parent.blockHash.toLowerCase() !== block.parentHash.toLowerCase()) {
      throw new Error(`Seed parent hash for block ${block.blockNumber} does not match ${block.parentHash}`);
    }
    return this.recordingClient ? this.recordHeader(parent) : parent;
  }

  public async getApi(block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>) {
    if (this.recordingClient) return this.getRecordingApi(block);

    const runtime = this.getRuntime(block.blockNumber);
    const query: Record<string, Record<string, unknown>> = {};

    for (const section of Object.keys(runtime.storage)) {
      query[section] = {};
      for (const method of Object.keys(runtime.storage[section])) {
        const entry = runtime.storage[section][method];
        query[section][method] = Object.assign(
          async (...args: unknown[]) => {
            const value = this.readStorage(block.blockNumber, block.blockHash, runtime, entry, args, true);
            return value!;
          },
          {
            keys: async (...args: unknown[]) => this.readStorageKeys(block.blockNumber, runtime, entry, args),
            multi: async (argsList: unknown[]) => {
              return argsList.map(args => {
                const entryArgs = Array.isArray(args) ? args : [args];
                return this.readStorage(block.blockNumber, block.blockHash, runtime, entry, entryArgs, true)!;
              });
            },
          },
        );
      }
    }

    return {
      query,
      runtimeVersion: {
        specVersion: runtime.registry.createType('u32', runtime.specVersion),
      },
    };
  }

  public async getEventsWithSpec(
    block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>,
  ): Promise<{ events: FrameSystemEventRecord[]; specVersion: number }> {
    const record = this.database
      .prepare(
        `SELECT blocks.blockHash, blocks.specVersion, blocks.systemEvents, runtime.metadata
         FROM Blocks blocks
         JOIN RuntimeMetadata runtime ON runtime.specVersion = blocks.specVersion
         WHERE blocks.blockNumber = ?`,
      )
      .get(block.blockNumber) as
      | { blockHash: Uint8Array; specVersion: number; systemEvents: Uint8Array; metadata: Uint8Array }
      | undefined;
    if (!record) throw new Error(`Seed does not contain block ${block.blockNumber}`);

    const blockHash = u8aToHex(record.blockHash);
    if (blockHash.toLowerCase() !== block.blockHash.toLowerCase()) {
      throw new Error(`Seed block ${block.blockNumber} hash does not match ${block.blockHash}`);
    }

    const { registry } = this.getRuntime(block.blockNumber, record);
    const events = registry.createType<Vec<FrameSystemEventRecord>>('Vec<FrameSystemEventRecord>', record.systemEvents);
    return { events: [...events], specVersion: record.specVersion };
  }

  private async getRecordingApi(block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>) {
    const client = this.recordingClient!;
    await this.recordHeader(block);
    const api = await client.at(block.blockHash);
    const expectedSpecVersion = this.getRuntime(block.blockNumber).specVersion;
    if (api.runtimeVersion.specVersion.toNumber() !== expectedSpecVersion) {
      throw new Error(`Archive runtime at block ${block.blockNumber} does not match spec ${expectedSpecVersion}`);
    }

    const query = new Proxy(api.query, {
      get: (sections, section) => {
        const entries = Reflect.get(sections, section) as QueryableModuleStorage<'promise'> | undefined;
        if (!entries || typeof section !== 'string') return entries;

        return new Proxy(entries, {
          get: (storageEntries, method) => {
            const entry = Reflect.get(storageEntries, method) as QueryableStorageEntry<'promise'> | undefined;
            if (!entry || typeof method !== 'string') return entry;

            return new Proxy(entry, {
              apply: async (storageEntry, thisArg, args: unknown[]) => {
                const result: unknown = await Reflect.apply(storageEntry, thisArg, args);
                await this.recordStorage(block, [storageEntry.key(...args)]);
                return result;
              },
              get: (storageEntry, property) => {
                if (property === 'keys') {
                  return async (...args: unknown[]) => {
                    const keys = await storageEntry.keys(...args);
                    await this.recordStorage(
                      block,
                      keys.map(key => key.toHex()),
                    );
                    return keys;
                  };
                }
                if (property === 'multi') {
                  return async (argsList: unknown[]) => {
                    const result = await storageEntry.multi(argsList);
                    const keys = argsList.map(args => storageEntry.key(...(Array.isArray(args) ? args : [args])));
                    await this.recordStorage(block, keys);
                    return result;
                  };
                }
                const propertyValue: unknown = Reflect.get(storageEntry, property);
                return propertyValue;
              },
            });
          },
        });
      },
    });

    return new Proxy(api, {
      get: (liveApi, property, receiver) => {
        if (property === 'query') return query;
        const propertyValue: unknown = Reflect.get(liveApi, property, receiver);
        return propertyValue;
      },
    });
  }

  private async recordHeader(block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>): Promise<IBlockHeaderInfo> {
    const recorded = this.database
      .prepare('SELECT 1 FROM RecoveryHeaders WHERE blockNumber = ?')
      .get(block.blockNumber);
    if (recorded) {
      const header = await this.getHeader(block);
      Object.assign(block, header);
      return header;
    }

    const liveHeader = await this.recordingClient!.rpc.chain.getHeader(block.blockHash);
    const header = BlockWatch.readHeader(liveHeader, true);
    if (header.blockNumber !== block.blockNumber || header.blockHash.toLowerCase() !== block.blockHash.toLowerCase()) {
      throw new Error(`Archive header does not match seed block ${block.blockNumber}`);
    }
    this.database
      .prepare(
        `INSERT OR REPLACE INTO RecoveryHeaders (
           blockNumber, blockTime, tick, author, frameId, frameRewardTicksRemaining, isNewFrame
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        header.blockNumber,
        header.blockTime,
        header.tick,
        header.author,
        header.frameId ?? null,
        header.frameRewardTicksRemaining ?? null,
        header.isNewFrame == null ? null : Number(header.isNewFrame),
      );
    Object.assign(block, header);
    return header;
  }

  private async recordStorage(
    block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>,
    storageKeys: string[],
  ): Promise<void> {
    if (!storageKeys.length) return;

    const storageValues = await this.recordingClient!.rpc.state.queryStorageAt<Codec[]>(storageKeys, block.blockHash);
    const insert = this.database.prepare(`
      INSERT OR REPLACE INTO RecoveryStorage (blockNumber, storageKey, storageValue)
      VALUES (:blockNumber, :storageKey, :storageValue)
    `);
    for (let index = 0; index < storageKeys.length; index += 1) {
      const storageValue = storageValues[index];
      insert.run({
        blockNumber: block.blockNumber,
        storageKey: hexToU8a(storageKeys[index]),
        storageValue: !storageValue || storageValue.isEmpty ? null : hexToU8a(storageValue.toHex()),
      });
    }
  }

  private getRuntime(
    blockNumber: number,
    blockRecord?: { specVersion: number; metadata: Uint8Array },
  ): { registry: TypeRegistry; specVersion: number; storage: ReturnType<typeof decorateStorage> } {
    blockRecord ??= this.database
      .prepare(
        `SELECT blocks.specVersion, runtime.metadata
         FROM Blocks blocks
         JOIN RuntimeMetadata runtime ON runtime.specVersion = blocks.specVersion
         WHERE blocks.blockNumber = ?`,
      )
      .get(blockNumber) as { specVersion: number; metadata: Uint8Array } | undefined;
    if (!blockRecord) throw new Error(`Seed does not contain runtime metadata for block ${blockNumber}`);

    let runtime = this.runtimes.get(blockRecord.specVersion);
    if (!runtime) {
      const registry = new TypeRegistry();
      const metadata = new Metadata(registry, blockRecord.metadata);
      registry.setMetadata(metadata, undefined, undefined, true);
      runtime = {
        registry,
        specVersion: blockRecord.specVersion,
        storage: decorateStorage(registry, metadata.asLatest, metadata.version),
      };
      this.runtimes.set(blockRecord.specVersion, runtime);
    }
    return runtime;
  }

  private readStorage(
    blockNumber: number,
    blockHash: string,
    runtime: { registry: TypeRegistry },
    entry: StorageEntry,
    args: unknown[],
    required: boolean,
  ): Codec | undefined {
    const storageKey = compactStripLength(entry(...args))[1];
    const record = this.database
      .prepare('SELECT storageValue FROM RecoveryStorage WHERE blockNumber = ? AND storageKey = ?')
      .get(blockNumber, storageKey) as { storageValue: Uint8Array | null } | undefined;
    if (!record) {
      if (!required) return;
      throw new Error(`Seed does not contain ${entry.section}.${entry.method} at block ${blockNumber}`);
    }

    const { registry } = runtime;
    const type = registry.createLookupType(unwrapStorageSi(entry.meta.type));
    const isEmpty = record.storageValue === null;
    let input: unknown = record.storageValue ?? undefined;
    if (isEmpty && entry.meta.fallback) input = hexToU8a(entry.meta.fallback.toHex());
    if (!isEmpty && entry.meta.modifier.isOptional) {
      input = registry.createTypeUnsafe(type, [record.storageValue], { blockHash: hexToU8a(blockHash) });
    }

    return registry.createTypeUnsafe(type, [input], {
      blockHash: hexToU8a(blockHash),
      isFallback: isEmpty && Boolean(entry.meta.fallback),
      isOptional: entry.meta.modifier.isOptional,
    });
  }

  private readStorageKeys(
    blockNumber: number,
    runtime: { registry: TypeRegistry },
    entry: StorageEntry,
    args: unknown[],
  ): StorageKey[] {
    const prefix = entry.keyPrefix(...args);
    const records = this.database
      .prepare('SELECT storageKey FROM RecoveryStorage WHERE blockNumber = ?')
      .all(blockNumber) as unknown as { storageKey: Uint8Array }[];

    return records.flatMap(({ storageKey }) => {
      if (storageKey.length < prefix.length) return [];
      for (let index = 0; index < prefix.length; index += 1) {
        if (storageKey[index] !== prefix[index]) return [];
      }

      return [new StorageKey(runtime.registry, u8aToHex(storageKey)).setMeta(entry.meta, entry.section, entry.method)];
    });
  }
}
