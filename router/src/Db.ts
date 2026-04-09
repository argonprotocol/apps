import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { ProfileTable } from './db/ProfileTable.ts';
import { migrations } from './db/migrations/index.ts';
import { UserInvitesTable } from './db/UserInvitesTable.ts';
import { BitcoinLockCouponsTable } from './db/BitcoinLockCouponsTable.ts';
import { ROUTER_DB_PATH } from './env.ts';
export { ROUTER_DB_PATH } from './env.ts';

export class Db {
  public readonly sql: DatabaseSync;
  #profileTable?: ProfileTable;
  #userInvitesTable?: UserInvitesTable;
  #bitcoinLockCouponsTable?: BitcoinLockCouponsTable;

  constructor(dbPath: string = ROUTER_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sql = new DatabaseSync(dbPath);
  }

  public migrate(): void {
    runSqliteMigrations(this.sql, migrations);
  }

  public get profileTable(): ProfileTable {
    this.#profileTable ??= new ProfileTable(this);
    return this.#profileTable;
  }

  public get userInvitesTable(): UserInvitesTable {
    this.#userInvitesTable ??= new UserInvitesTable(this);
    return this.#userInvitesTable;
  }

  public get bitcoinLockCouponsTable(): BitcoinLockCouponsTable {
    this.#bitcoinLockCouponsTable ??= new BitcoinLockCouponsTable(this);
    return this.#bitcoinLockCouponsTable;
  }

  public close(): void {
    this.sql.close();
  }
}
