import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { ProfileTable } from './db/ProfileTable.ts';
import { migrations } from './db/migrations/index.ts';
import { TreasuryUserInvitesTable } from './db/TreasuryUserInvitesTable.ts';
import { ROUTER_DB_PATH } from './env.ts';
export { ROUTER_DB_PATH } from './env.ts';

export class Db {
  public readonly sql: DatabaseSync;
  #profileTable?: ProfileTable;
  #treasuryUserInvitesTable?: TreasuryUserInvitesTable;

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

  public get treasuryUserInvitesTable(): TreasuryUserInvitesTable {
    this.#treasuryUserInvitesTable ??= new TreasuryUserInvitesTable(this);
    return this.#treasuryUserInvitesTable;
  }

  public close(): void {
    this.sql.close();
  }
}
