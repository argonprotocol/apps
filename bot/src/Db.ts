import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { migrations } from './db/migrations/index.ts';

export class Db {
  public readonly sql: DatabaseSync;

  constructor(datadir: string) {
    const dbPath = join(datadir, 'vault.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sql = new DatabaseSync(dbPath);
  }

  public migrate(): void {
    runSqliteMigrations(this.sql, migrations);
  }

  public close(): void {
    this.sql.close();
  }
}
