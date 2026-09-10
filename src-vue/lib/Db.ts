import PluginSql, { QueryResult } from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import { CohortFramesTable } from './db/CohortFramesTable';
import { CohortsTable } from './db/CohortsTable';
import { ConfigTable } from './db/ConfigTable';
import { FramesTable } from './db/FramesTable';
import { SyncStateTable } from './db/SyncStateTable.ts';
import { INSTANCE_NAME, NETWORK_NAME } from './Env';
import { ensureOnlyOneInstance } from './Utils';
import { FrameBidsTable } from './db/FrameBidsTable';
import { VaultsTable } from './db/VaultsTable.ts';
import { BitcoinLocksTable } from './db/BitcoinLocksTable.ts';
import { TransactionsTable } from './db/TransactionsTable.ts';
import { BaseTable } from './db/BaseTable.ts';
import { VaultRevenueEventsTable } from './db/VaultRevenueEventsTable.ts';
import { WalletTransfersTable } from './db/WalletTransfersTable.ts';
import { BitcoinUtxosTable } from './db/BitcoinUtxosTable.ts';
import { TransactionStatusHistoryTable } from './db/TransactionStatusHistoryTable.ts';
import { StableSwapSyncStateTable } from './db/StableSwapSyncStateTable.ts';
import { StableSwapPurchasesTable } from './db/StableSwapPurchasesTable.ts';
import { CrosschainInboundTransfersTable } from './db/CrosschainInboundTransfersTable.ts';
import { CrosschainOutboundTransfersTable } from './db/CrosschainOutboundTransfersTable.ts';
import { WalletHdKeysTable } from './db/WalletHdKeysTable.ts';
import { WalletsTable } from './db/WalletsTable.ts';
import { BondLotHistoryTable } from './db/BondLotHistoryTable.ts';
import { VaultCapitalHistoryTable } from './db/VaultCapitalHistoryTable.ts';
import { FinancialCacheTable } from './db/FinancialCacheTable.ts';
import { BitcoinFissionsTable } from './db/BitcoinFissionsTable.ts';
import { BitcoinSecuritizationHistoryTable } from './db/BitcoinSecuritizationHistoryTable.ts';

export class Db {
  public sql: PluginSql;
  public hasMigrationError: boolean;
  public syncStateTable: SyncStateTable;
  public cohortFramesTable: CohortFramesTable;
  public cohortsTable: CohortsTable;
  public configTable: ConfigTable;
  public framesTable: FramesTable;
  public frameBidsTable: FrameBidsTable;
  public transactionsTable: TransactionsTable;
  public transactionStatusHistoryTable: TransactionStatusHistoryTable;
  public vaultsTable: VaultsTable;
  public vaultRevenueEventsTable: VaultRevenueEventsTable;
  public bitcoinLocksTable: BitcoinLocksTable;
  public walletTransfersTable: WalletTransfersTable;
  public crosschainInboundTransfersTable: CrosschainInboundTransfersTable;
  public crosschainOutboundTransfersTable: CrosschainOutboundTransfersTable;
  public walletHdKeysTable: WalletHdKeysTable;
  public walletsTable: WalletsTable;
  public bitcoinUtxosTable: BitcoinUtxosTable;
  public stableSwapSyncStateTable: StableSwapSyncStateTable;
  public stableSwapPurchasesTable: StableSwapPurchasesTable;
  public bondLotHistoryTable: BondLotHistoryTable;
  public vaultCapitalHistoryTable: VaultCapitalHistoryTable;
  public financialCacheTable: FinancialCacheTable;
  public bitcoinFissionsTable: BitcoinFissionsTable;
  public bitcoinSecuritizationHistoryTable: BitcoinSecuritizationHistoryTable;
  private readonly transactionId?: number;
  private readonly tableStates: Map<object, unknown>;

  constructor(
    sql: PluginSql,
    hasMigrationError: boolean,
    transaction?: { id: number; tableStates: Map<object, unknown> },
  ) {
    if (!transaction) ensureOnlyOneInstance(this.constructor);

    this.sql = sql;
    this.hasMigrationError = hasMigrationError;
    this.transactionId = transaction?.id;
    this.tableStates = transaction?.tableStates ?? new Map();
    this.syncStateTable = new SyncStateTable(this);
    this.cohortFramesTable = new CohortFramesTable(this);
    this.cohortsTable = new CohortsTable(this);
    this.configTable = new ConfigTable(this);
    this.framesTable = new FramesTable(this);
    this.frameBidsTable = new FrameBidsTable(this);
    this.vaultsTable = new VaultsTable(this);
    this.vaultRevenueEventsTable = new VaultRevenueEventsTable(this);
    this.transactionsTable = new TransactionsTable(this);
    this.transactionStatusHistoryTable = new TransactionStatusHistoryTable(this);
    this.bitcoinLocksTable = new BitcoinLocksTable(this);
    this.walletTransfersTable = new WalletTransfersTable(this);
    this.crosschainInboundTransfersTable = new CrosschainInboundTransfersTable(this);
    this.crosschainOutboundTransfersTable = new CrosschainOutboundTransfersTable(this);
    this.walletHdKeysTable = new WalletHdKeysTable(this);
    this.walletsTable = new WalletsTable(this);
    this.bitcoinUtxosTable = new BitcoinUtxosTable(this);
    this.stableSwapSyncStateTable = new StableSwapSyncStateTable(this);
    this.stableSwapPurchasesTable = new StableSwapPurchasesTable(this);
    this.bondLotHistoryTable = new BondLotHistoryTable(this);
    this.vaultCapitalHistoryTable = new VaultCapitalHistoryTable(this);
    this.financialCacheTable = new FinancialCacheTable(this);
    this.bitcoinFissionsTable = new BitcoinFissionsTable(this);
    this.bitcoinSecuritizationHistoryTable = new BitcoinSecuritizationHistoryTable(this);
  }

  public getTableState<State>(table: object, initialize: () => State): State {
    if (!this.tableStates.has(table)) this.tableStates.set(table, initialize());
    return this.tableStates.get(table) as State;
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
      if (this.transactionId !== undefined) {
        return await invoke<QueryResult>('sql_execute', {
          transactionId: this.transactionId,
          query,
          values: bindValues ?? [],
        });
      }
      return await this.sql.execute(query, bindValues);
    } catch (error) {
      console.error('Error executing query:', { query, error });
      throw error;
    }
  }

  public async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    try {
      if (this.transactionId !== undefined) {
        const rows = await invoke<T>('sql_select', {
          transactionId: this.transactionId,
          query,
          values: bindValues ?? [],
        });
        return normalizeSqlRows(rows);
      }
      const rows = await this.sql.select<T>(query, bindValues);
      return normalizeSqlRows(rows);
    } catch (error) {
      console.error('Error selecting query:', { query, error });
      throw error;
    }
  }

  // Transaction tables share their root table's state. Keep cache and revision mutations outside
  // the callback so a database rollback cannot leave in-memory state published.
  public async transaction<T>(callback: (transaction: Db) => Promise<T>): Promise<T> {
    if (this.transactionId !== undefined) throw new Error('Nested SQL transactions are not supported');
    if (this.writesPaused) throw new Error('Cannot start a SQL transaction while database writes are paused');

    const transactionId = await invoke<number>('sql_begin_transaction', { db: this.sql.path });
    const transaction = new Db(this.sql, this.hasMigrationError, { id: transactionId, tableStates: this.tableStates });
    let result: T;
    try {
      result = await callback(transaction);
    } catch (error) {
      try {
        await invoke('sql_rollback_transaction', { transactionId });
      } catch (rollbackError) {
        console.warn(`Unable to roll back SQL transaction ${transactionId}`, rollbackError);
      }
      throw error;
    }

    await invoke('sql_commit_transaction', { transactionId });
    return result;
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

function normalizeSqlRows<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [field, value] of Object.entries(row)) {
      if (value === null) delete (row as Record<string, unknown>)[field];
    }
  }
  return rows;
}
