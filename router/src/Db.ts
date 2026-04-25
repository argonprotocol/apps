import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { SessionsTable } from './db/SessionsTable.ts';
import { migrations } from './db/migrations/index.ts';
import { UsersTable } from './db/UsersTable.ts';
import { UserInvitesTable } from './db/UserInvitesTable.ts';
import { ROUTER_DB_PATH } from './env.ts';
export { ROUTER_DB_PATH } from './env.ts';

export class Db {
  public readonly sql: DatabaseSync;
  #sessionsTable?: SessionsTable;
  #usersTable?: UsersTable;
  #userInvitesTable?: UserInvitesTable;

  constructor(dbPath: string = ROUTER_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sql = new DatabaseSync(dbPath);
  }

  public migrate(): void {
    runSqliteMigrations(this.sql, migrations);
  }

  public get usersTable(): UsersTable {
    this.#usersTable ??= new UsersTable(this);
    return this.#usersTable;
  }

  public get sessionsTable(): SessionsTable {
    this.#sessionsTable ??= new SessionsTable(this);
    return this.#sessionsTable;
  }

  public get userInvitesTable(): UserInvitesTable {
    this.#userInvitesTable ??= new UserInvitesTable(this);
    return this.#userInvitesTable;
  }

  public transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');

    try {
      const result = fn();
      if (result && typeof result === 'object' && 'then' in result) {
        throw new Error('Db.transaction callback must be synchronous.');
      }

      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  public close(): void {
    this.sql.close();
  }
}
