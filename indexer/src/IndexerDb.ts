import { DatabaseSync, type StatementSync } from 'node:sqlite';
import Path from 'path';
import * as Fs from 'node:fs';

export enum WalletTransferSource {
  Transfer = 0,
  Faucet = 1,
  TokenGateway = 2,
}
export enum WalletTransferCurrency {
  Argon = 0,
  Argonot = 1,
}

export interface IWalletTransferRecord {
  toAddress: string;
  fromAddress: string | null;
  source: WalletTransferSource;
  currency: WalletTransferCurrency;
  blockNumber: number;
}

export interface IVaultCollectRecord {
  vaultAddress: string;
  blockNumber: number;
}

export class IndexerDb {
  public latestSyncedBlock!: number;

  private readonly database: DatabaseSync;
  private statementCache: Record<string, StatementSync> = {};

  constructor(databasePath: string) {
    console.log('opening database at', databasePath);
    this.database = new DatabaseSync(databasePath, {
      open: true,
    });
    this.load();
    this.latestSyncedBlock = this.getLatestSyncedBlock() ?? 0;
  }

  public static copySeedIfNeeded(dbDir: string, network: string) {
    const databasePath = Path.join(dbDir, `${network}.db`);
    if (!Fs.existsSync(databasePath)) {
      const seedsDir = Path.join(import.meta.dirname, '..', 'seeds');
      if (Fs.existsSync(Path.join(seedsDir, `${network}.db`))) {
        console.info(`Copying seed database from ${seedsDir} to ${databasePath}`);
        Fs.mkdirSync(Path.dirname(databasePath), { recursive: true });
        Fs.copyFileSync(Path.join(seedsDir, `${network}.db`), databasePath);
      }
    }
  }

  public close() {
    this.database.close();
  }

  private load() {
    const database = this.database;
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = NORMAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    // Execute SQL statements from strings.
    database.exec(`
  CREATE TABLE IF NOT EXISTS SchemaVersion (
      version INTEGER PRIMARY KEY,
      applied_on DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

    const currentVersion =
      database.prepare(`SELECT COALESCE(MAX(version), 0) as version FROM SchemaVersion`).get()?.version ?? 0;
    console.log(`Current DB schema version: ${currentVersion}`);
    if (Number(currentVersion) < 1) {
      database.exec(Schema1);
    }
  }

  public findAddressTransfers(address: string): IWalletTransferRecord[] {
    this.statementCache['findAddressTransfers'] ??= this.database.prepare(
      `
      SELECT *
      FROM WalletTransferBlocks
      WHERE toAddress = :address OR fromAddress = :address
      ORDER BY blockNumber DESC
    `,
    );
    return this.statementCache['findAddressTransfers'].all({ address }) as unknown as IWalletTransferRecord[];
  }

  public findVaultCollects(vaultAddress: string): IVaultCollectRecord[] {
    this.statementCache['findVaultCollects'] ??= this.database.prepare(
      `
      SELECT *
      FROM VaultCollectBlocks
      WHERE vaultAddress = :vaultAddress
      ORDER BY blockNumber DESC
    `,
    );
    return this.statementCache['findVaultCollects'].all({ vaultAddress }) as unknown as IVaultCollectRecord[];
  }

  public recordFinalizedBlock(data: {
    blockNumber: number;
    transfers: Omit<IWalletTransferRecord, 'blockNumber'>[];
    vaultCollects: Omit<IVaultCollectRecord, 'blockNumber'>[];
  }) {
    const database = this.database;
    const { blockNumber, transfers, vaultCollects } = data;
    // ensure we are on the right block
    if (this.latestSyncedBlock >= blockNumber) {
      return;
    }
    this.statementCache['insertVaultCollect'] ??= database.prepare(`
      INSERT INTO VaultCollectBlocks (vaultAddress, blockNumber)
      VALUES (:vaultAddress, :blockNumber)
    `);
    this.statementCache['insertBlock'] ??= database.prepare(`
      INSERT OR REPLACE INTO SyncState (id, blockNumber, syncedAt)
      VALUES ('latest', :blockNumber, CURRENT_TIMESTAMP)`);
    this.statementCache['insertTransfer'] ??= database.prepare(`
      INSERT INTO WalletTransferBlocks (toAddress, fromAddress, source, currency, blockNumber)
      VALUES (:toAddress, :fromAddress, :source, :currency, :blockNumber)
    `);

    if (transfers.length > 0 || vaultCollects.length > 0) {
      console.log(
        `[${new Date().toISOString()}] Recording finalized block #${blockNumber} with ${transfers.length} transfers and ${vaultCollects.length} vault collects`,
      );
    }

    try {
      database.exec('BEGIN TRANSACTION;');
      this.statementCache['insertBlock'].run({ blockNumber });

      const transferKeys = new Set<string>();
      for (const transfer of transfers) {
        const key = `${transfer.toAddress}-${transfer.fromAddress}-${transfer.source}-${transfer.currency}`;

        if (transferKeys.has(key)) {
          continue;
        }
        transferKeys.add(key);
        this.statementCache['insertTransfer'].run({ ...transfer, blockNumber });
      }

      const alreadyInserted = new Set<string>();
      for (const collect of vaultCollects) {
        if (alreadyInserted.has(collect.vaultAddress)) {
          continue;
        }
        alreadyInserted.add(collect.vaultAddress);
        this.statementCache['insertVaultCollect'].run({ ...collect, blockNumber });
      }

      database.exec('COMMIT;');
      this.latestSyncedBlock = Math.max(blockNumber, this.latestSyncedBlock);
    } catch (error) {
      console.error(`Error committing transaction at ${blockNumber}`, error, JSON.stringify(data, null, 2));
      database.exec('ROLLBACK;');
    }
  }

  private getLatestSyncedBlock(): number {
    const result = this.database.prepare(`SELECT * FROM SyncState WHERE id = 'latest' LIMIT 1`).get() as unknown as {
      blockNumber: number;
    } | null;
    return result?.blockNumber ?? 0;
  }
}

const Schema1 = `CREATE TABLE WalletTransferBlocks (
    toAddress TEXT NOT NULL,
    fromAddress TEXT,
    source INTEGER NOT NULL,
    currency INTEGER NOT NULL,
    blockNumber INTEGER
  );

  CREATE INDEX idxWalletTransferBlocksToAddress ON WalletTransferBlocks (toAddress);
  CREATE INDEX idxWalletTransferBlocksFromAddress ON WalletTransferBlocks (fromAddress);

  CREATE TABLE VaultCollectBlocks (
    vaultAddress TEXT,
    blockNumber INTEGER,
    PRIMARY KEY (vaultAddress, blockNumber)
  );
  CREATE INDEX idxVaultCollectBlocksvaultAddress ON VaultCollectBlocks (vaultAddress);

  CREATE TABLE SyncState (
    id TEXT PRIMARY KEY,
    blockNumber INTEGER,
    syncedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO SchemaVersion (version) VALUES (1);
`;
