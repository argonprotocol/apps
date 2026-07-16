import { DatabaseSync, type StatementSync } from 'node:sqlite';

export enum WalletTransferSource {
  Transfer = 0,
  Faucet = 1,
  TokenGateway = 2,
  Ethereum = 3,
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

export class LegacyIndexerDb {
  public latestSyncedBlock: number;

  private readonly database: DatabaseSync;
  private readonly statementCache: Record<string, StatementSync> = {};

  constructor(databasePath: string) {
    console.log('opening database at', databasePath);
    this.database = new DatabaseSync(databasePath, { open: true });
    this.load();
    this.latestSyncedBlock = this.getLatestSyncedBlock();
  }

  public close(): void {
    this.database.close();
  }

  public findAddressTransfers(address: string): IWalletTransferRecord[] {
    this.statementCache.findAddressTransfers ??= this.database.prepare(`
      SELECT *
      FROM WalletTransferBlocks
      WHERE toAddress = :address OR fromAddress = :address
      ORDER BY blockNumber DESC
    `);
    return this.statementCache.findAddressTransfers.all({ address }) as unknown as IWalletTransferRecord[];
  }

  public findVaultCollects(vaultAddress: string): IVaultCollectRecord[] {
    this.statementCache.findVaultCollects ??= this.database.prepare(`
      SELECT *
      FROM VaultCollectBlocks
      WHERE vaultAddress = :vaultAddress
      ORDER BY blockNumber DESC
    `);
    return this.statementCache.findVaultCollects.all({ vaultAddress }) as unknown as IVaultCollectRecord[];
  }

  public recordFinalizedBlock(data: {
    blockNumber: number;
    transfers: Omit<IWalletTransferRecord, 'blockNumber'>[];
    vaultCollects: Omit<IVaultCollectRecord, 'blockNumber'>[];
  }): void {
    const { blockNumber, transfers, vaultCollects } = data;
    if (this.latestSyncedBlock >= blockNumber) return;

    this.statementCache.insertVaultCollect ??= this.database.prepare(`
      INSERT INTO VaultCollectBlocks (vaultAddress, blockNumber)
      VALUES (:vaultAddress, :blockNumber)
    `);
    this.statementCache.insertBlock ??= this.database.prepare(`
      INSERT OR REPLACE INTO SyncState (id, blockNumber, syncedAt)
      VALUES ('latest', :blockNumber, CURRENT_TIMESTAMP)
    `);
    this.statementCache.insertTransfer ??= this.database.prepare(`
      INSERT INTO WalletTransferBlocks (toAddress, fromAddress, source, currency, blockNumber)
      VALUES (:toAddress, :fromAddress, :source, :currency, :blockNumber)
    `);

    if (transfers.length > 0 || vaultCollects.length > 0) {
      console.log(
        `[${new Date().toISOString()}] Recording finalized block #${blockNumber} with ${transfers.length} transfers and ${vaultCollects.length} vault collects`,
      );
    }

    try {
      this.database.exec('BEGIN TRANSACTION;');
      this.statementCache.insertBlock.run({ blockNumber });

      const transferKeys = new Set<string>();
      for (const transfer of transfers) {
        const key = `${transfer.toAddress}-${transfer.fromAddress}-${transfer.source}-${transfer.currency}`;
        if (transferKeys.has(key)) continue;

        transferKeys.add(key);
        this.statementCache.insertTransfer.run({ ...transfer, blockNumber });
      }

      const vaultAddresses = new Set<string>();
      for (const collect of vaultCollects) {
        if (vaultAddresses.has(collect.vaultAddress)) continue;

        vaultAddresses.add(collect.vaultAddress);
        this.statementCache.insertVaultCollect.run({ ...collect, blockNumber });
      }

      this.database.exec('COMMIT;');
      this.latestSyncedBlock = blockNumber;
    } catch (error) {
      console.error(`Error committing transaction at ${blockNumber}`, error, JSON.stringify(data, null, 2));
      this.database.exec('ROLLBACK;');
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
    console.log(`Current DB schema version: ${currentVersion}`);
    if (currentVersion < 1) this.database.exec(Schema1);
  }

  private getLatestSyncedBlock(): number {
    const result = this.database.prepare(`SELECT blockNumber FROM SyncState WHERE id = 'latest' LIMIT 1`).get() as
      | { blockNumber: number }
      | undefined;
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
