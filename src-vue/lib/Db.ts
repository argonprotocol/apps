import PluginSql, { QueryResult } from '@tauri-apps/plugin-sql';
import { CohortFramesTable } from './db/CohortFramesTable';
import { CohortsTable } from './db/CohortsTable';
import { ConfigTable } from './db/ConfigTable';
import { FramesTable } from './db/FramesTable';
import { ServerStateTable } from './db/ServerStateTable.ts';
import { INSTANCE_NAME, NETWORK_NAME } from './Env';
import { ensureOnlyOneInstance } from './Utils';
import { FrameBidsTable } from './db/FrameBidsTable';
import { VaultsTable } from './db/VaultsTable.ts';
import { BitcoinLocksTable } from './db/BitcoinLocksTable.ts';
import { TransactionsTable } from './db/TransactionsTable.ts';
import { WalletLedgerTable } from './db/WalletLedgerTable.ts';
import { BaseTable } from './db/BaseTable.ts';

export class Db {
  public sql: PluginSql;
  public hasMigrationError: boolean;
  public serverStateTable: ServerStateTable;
  public cohortFramesTable: CohortFramesTable;
  public cohortsTable: CohortsTable;
  public configTable: ConfigTable;
  public framesTable: FramesTable;
  public frameBidsTable: FrameBidsTable;
  public transactionsTable: TransactionsTable;
  public vaultsTable: VaultsTable;
  public bitcoinLocksTable: BitcoinLocksTable;
  public walletLedgerTable: WalletLedgerTable;

  constructor(sql: PluginSql, hasMigrationError: boolean) {
    ensureOnlyOneInstance(this.constructor);

    this.sql = sql;
    this.hasMigrationError = hasMigrationError;
    this.serverStateTable = new ServerStateTable(this);
    this.cohortFramesTable = new CohortFramesTable(this);
    this.cohortsTable = new CohortsTable(this);
    this.configTable = new ConfigTable(this);
    this.framesTable = new FramesTable(this);
    this.frameBidsTable = new FrameBidsTable(this);
    this.vaultsTable = new VaultsTable(this);
    this.transactionsTable = new TransactionsTable(this);
    this.bitcoinLocksTable = new BitcoinLocksTable(this);
    this.walletLedgerTable = new WalletLedgerTable(this);
  }

  public static async load(retries: number = 0): Promise<Db> {
    try {
      const sql = await PluginSql.load(`sqlite:${Db.relativePath}`);
      const db = new Db(sql, !!retries);
      for (const table of Object.values(db)) {
        if (table instanceof BaseTable) {
          await table.loadState();
        }
      }
      return db;
    } catch (error) {
      if (typeof error == 'string' && error.startsWith('migration ') && retries < 1) {
        return this.load(retries + 1);
      }
      throw error;
    }
  }

  private writesPaused = false;

  public async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    if (this.writesPaused) {
      return { rowsAffected: 0 };
    }
    try {
      return await this.sql.execute(query, bindValues);
    } catch (error) {
      console.error('Error executing query:', { query, bindValues, error });
      throw error;
    }
  }

  public async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    try {
      return await this.sql.select<T>(query, bindValues);
    } catch (error) {
      console.error('Error selecting query:', { query, bindValues, error });
      throw error;
    }
  }

  public async close() {
    await this.sql.close();
  }

  public pauseWrites() {
    this.writesPaused = true;
  }

  public resumeWrites() {
    this.writesPaused = false;
  }

  public async reconnect() {
    this.writesPaused = false;

    this.sql = await PluginSql.load(`sqlite:${Db.relativePath}`);
  }

  public static get relativeDir(): string {
    return `${NETWORK_NAME}/${INSTANCE_NAME}`;
  }

  public static get relativePath() {
    return `${this.relativeDir}/database.sqlite`;
  }
}
