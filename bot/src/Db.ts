import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { BitcoinLockCouponsTable } from './db/BitcoinLockCouponsTable.ts';
import { BitcoinLockRelaysTable } from './db/BitcoinLockRelaysTable.ts';
import { migrations } from './db/migrations/index.ts';

export class Db {
  public readonly sql: DatabaseSync;
  #bitcoinLockCouponsTable?: BitcoinLockCouponsTable;
  #bitcoinLockRelaysTable?: BitcoinLockRelaysTable;

  constructor(datadir: string) {
    const dbPath = join(datadir, 'vault.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sql = new DatabaseSync(dbPath);
  }

  public migrate(): void {
    runSqliteMigrations(this.sql, migrations);
  }

  public get bitcoinLockCouponsTable(): BitcoinLockCouponsTable {
    this.#bitcoinLockCouponsTable ??= new BitcoinLockCouponsTable(this);
    return this.#bitcoinLockCouponsTable;
  }

  public get bitcoinLockRelaysTable(): BitcoinLockRelaysTable {
    this.#bitcoinLockRelaysTable ??= new BitcoinLockRelaysTable(this);
    return this.#bitcoinLockRelaysTable;
  }

  public close(): void {
    this.sql.close();
  }
}
