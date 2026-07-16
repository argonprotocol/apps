import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { IAccountActivityQuery } from '@argonprotocol/apps-core';
import { accountActivityKindNames } from './AccountActivity.js';
import { AccountActivityCoverageError } from './HistoricalEventSpecs.js';

export interface IAccountActivityRecord {
  blockNumber: number;
  blockHash: Uint8Array;
  specVersion: number;
  activityMask: number;
}

export interface IAccountActivityBlock {
  blockNumber: number;
  blockHash: Uint8Array;
  specVersion: number;
  accounts: { address: string; mask: number }[];
  vaults: { vaultId: number; mask: number }[];
  vaultOwners: { vaultId: number; address: string }[];
  bitcoinLocks?: { utxoId: number; mask: number }[];
  bitcoinLockOwners?: { utxoId: number; address: string }[];
}

export const ACCOUNT_ACTIVITY_DEFINITION_VERSION = 1;
const syncStateId = 'accountActivity';

export class IncompatibleAccountActivityDatabaseError extends Error {}

type StatementName =
  | 'findAddressActivity'
  | 'insertAccountBlock'
  | 'insertBitcoinLockOwner'
  | 'insertBlock'
  | 'insertVaultOwner'
  | 'updateSync';

export class IndexerDb {
  public latestSyncedBlock: number;

  private readonly database: DatabaseSync;
  private readonly statements = {} as Record<StatementName, StatementSync>;
  private readonly vaultOwners = new Map<number, string>();
  private readonly bitcoinLockOwners = new Map<number, string>();

  constructor(databasePath: string) {
    console.log('opening account activity database at', databasePath);
    this.database = new DatabaseSync(databasePath, { open: true });
    try {
      this.load();
      this.latestSyncedBlock = this.getLatestSyncedBlock();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  public close(): void {
    this.database.close();
  }

  public findAddressActivity(address: string, filters: IAccountActivityQuery = {}): IAccountActivityRecord[] {
    // AccountBlocks is the sparse accountId/blockNumber/mask association. This
    // join supplies the one canonical hash and spec stored for each block.
    this.statements.findAddressActivity ??= this.database.prepare(`
      SELECT b.blockNumber, b.blockHash, b.specVersion, ab.activityMask
      FROM AccountBlocks ab
      JOIN Blocks b ON b.blockNumber = ab.blockNumber
      WHERE ab.accountId = :address
        AND b.blockNumber > :afterBlock
        AND b.blockNumber <= :toBlock
        AND (ab.activityMask & :activityMask) != 0
      ORDER BY b.blockNumber ASC
    `);

    return this.statements.findAddressActivity.all({
      address,
      afterBlock: filters.afterBlock ?? 0,
      toBlock: filters.toBlock ?? Number.MAX_SAFE_INTEGER,
      activityMask: filters.activityMask ?? 0x7fffffff,
    }) as unknown as IAccountActivityRecord[];
  }

  public recordBlocks(blocks: IAccountActivityBlock[]): void {
    const pendingBlocks = blocks.filter(block => block.blockNumber > this.latestSyncedBlock);
    if (!pendingBlocks.length) return;

    this.prepareWriteStatements();
    const pendingVaultOwners = new Map<number, string>();
    const pendingBitcoinLockOwners = new Map<number, string>();

    try {
      this.database.exec('BEGIN TRANSACTION;');
      for (const block of pendingBlocks) {
        this.statements.insertBlock.run({
          blockNumber: block.blockNumber,
          blockHash: block.blockHash,
          specVersion: block.specVersion,
        });

        for (const { vaultId, address } of block.vaultOwners) {
          this.statements.insertVaultOwner.run({ vaultId, accountId: address });
          pendingVaultOwners.set(vaultId, address);
        }
        for (const { utxoId, address } of block.bitcoinLockOwners ?? []) {
          this.statements.insertBitcoinLockOwner.run({ utxoId, accountId: address });
          pendingBitcoinLockOwners.set(utxoId, address);
        }

        const accountMasks = new Map(block.accounts.map(({ address, mask }) => [address, mask]));
        for (const { vaultId, mask } of block.vaults) {
          const accountId = pendingVaultOwners.get(vaultId) ?? this.vaultOwners.get(vaultId);
          if (!accountId) {
            throw new AccountActivityCoverageError(`Vault ${vaultId} has activity before its owner is known`);
          }
          accountMasks.set(accountId, (accountMasks.get(accountId) ?? 0) | mask);
        }
        for (const { utxoId, mask } of block.bitcoinLocks ?? []) {
          const accountId = pendingBitcoinLockOwners.get(utxoId) ?? this.bitcoinLockOwners.get(utxoId);
          if (!accountId) {
            throw new AccountActivityCoverageError(`Bitcoin lock ${utxoId} has activity before its owner is known`);
          }
          accountMasks.set(accountId, (accountMasks.get(accountId) ?? 0) | mask);
        }
        for (const [accountId, activityMask] of accountMasks) {
          this.statements.insertAccountBlock.run({
            accountId,
            blockNumber: block.blockNumber,
            activityMask,
          });
        }
      }

      const lastBlock = pendingBlocks.at(-1)!;
      this.statements.updateSync.run({
        id: syncStateId,
        blockNumber: lastBlock.blockNumber,
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
      });
      this.database.exec('COMMIT;');

      for (const [vaultId, accountId] of pendingVaultOwners) this.vaultOwners.set(vaultId, accountId);
      for (const [utxoId, accountId] of pendingBitcoinLockOwners) this.bitcoinLockOwners.set(utxoId, accountId);
      this.latestSyncedBlock = lastBlock.blockNumber;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private load(): void {
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA synchronous = NORMAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS SchemaVersion (
        version INTEGER PRIMARY KEY,
        applied_on DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const currentVersion = Number(
      this.database.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM SchemaVersion`).get()?.version ?? 0,
    );
    console.log(`Current account activity DB schema version: ${currentVersion}`);
    if (currentVersion < 1) this.database.exec(CurrentSchema);

    const tables = new Set(
      (
        this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as unknown as {
          name: string;
        }[]
      ).map(record => record.name),
    );
    const missingTable = [
      'Blocks',
      'AccountBlocks',
      'VaultOwners',
      'BitcoinLockOwners',
      'ActivityKinds',
      'SyncState',
    ].find(table => !tables.has(table));
    if (missingTable) {
      throw new IncompatibleAccountActivityDatabaseError(
        `Account activity database is missing ${missingTable}; replace or rebuild the account activity database`,
      );
    }

    const insertKind = this.database.prepare(`INSERT OR IGNORE INTO ActivityKinds (bit, name) VALUES (:bit, :name)`);
    for (const [bit, name] of accountActivityKindNames) insertKind.run({ bit, name });

    const vaultOwners = this.database.prepare(`SELECT vaultId, accountId FROM VaultOwners`).all() as unknown as {
      vaultId: number;
      accountId: string;
    }[];
    for (const { vaultId, accountId } of vaultOwners) this.vaultOwners.set(vaultId, accountId);

    const bitcoinLockOwners = this.database
      .prepare(`SELECT utxoId, accountId FROM BitcoinLockOwners`)
      .all() as unknown as {
      utxoId: number;
      accountId: string;
    }[];
    for (const { utxoId, accountId } of bitcoinLockOwners) this.bitcoinLockOwners.set(utxoId, accountId);
  }

  private prepareWriteStatements(): void {
    this.statements.insertBlock ??= this.database.prepare(`
      INSERT INTO Blocks (blockNumber, blockHash, specVersion)
      VALUES (:blockNumber, :blockHash, :specVersion)
    `);
    this.statements.insertAccountBlock ??= this.database.prepare(`
      INSERT INTO AccountBlocks (accountId, blockNumber, activityMask)
      VALUES (:accountId, :blockNumber, :activityMask)
      ON CONFLICT (accountId, blockNumber)
      DO UPDATE SET activityMask = activityMask | excluded.activityMask
    `);
    this.statements.insertVaultOwner ??= this.database.prepare(`
      INSERT OR REPLACE INTO VaultOwners (vaultId, accountId) VALUES (:vaultId, :accountId)
    `);
    this.statements.insertBitcoinLockOwner ??= this.database.prepare(`
      INSERT OR REPLACE INTO BitcoinLockOwners (utxoId, accountId) VALUES (:utxoId, :accountId)
    `);
    this.statements.updateSync ??= this.database.prepare(`
      INSERT OR REPLACE INTO SyncState (id, blockNumber, definitionVersion, syncedAt)
      VALUES (:id, :blockNumber, :definitionVersion, CURRENT_TIMESTAMP)
    `);
  }

  private getLatestSyncedBlock(): number {
    const result = this.database
      .prepare(`SELECT blockNumber, definitionVersion FROM SyncState WHERE id = :id`)
      .get({ id: syncStateId }) as { blockNumber: number; definitionVersion: number } | undefined;

    if (result && result.definitionVersion !== ACCOUNT_ACTIVITY_DEFINITION_VERSION) {
      throw new IncompatibleAccountActivityDatabaseError(
        `Account activity definition ${result.definitionVersion} cannot resume with definition ${ACCOUNT_ACTIVITY_DEFINITION_VERSION}; replace or rebuild the account activity database`,
      );
    }
    return result?.blockNumber ?? 0;
  }
}

const CurrentSchema = `CREATE TABLE Blocks (
    blockNumber INTEGER PRIMARY KEY,
    blockHash BLOB NOT NULL,
    specVersion INTEGER NOT NULL
  );
  -- The composite primary key is also the account timeline index; avoid storing a duplicate rowid tree.
  CREATE TABLE AccountBlocks (
    accountId TEXT NOT NULL,
    blockNumber INTEGER NOT NULL REFERENCES Blocks(blockNumber),
    activityMask INTEGER NOT NULL,
    PRIMARY KEY (accountId, blockNumber)
  ) WITHOUT ROWID;
  CREATE TABLE VaultOwners (
    vaultId INTEGER PRIMARY KEY,
    accountId TEXT NOT NULL
  );
  CREATE TABLE BitcoinLockOwners (
    utxoId INTEGER PRIMARY KEY,
    accountId TEXT NOT NULL
  );
  CREATE TABLE ActivityKinds (
    bit INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE SyncState (
    id TEXT PRIMARY KEY,
    blockNumber INTEGER NOT NULL,
    definitionVersion INTEGER NOT NULL,
    syncedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO SchemaVersion (version) VALUES (1);
`;
