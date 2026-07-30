import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteMigrations } from '@argonprotocol/apps-core';
import { CohortFramesTable } from './mining-db/CohortFramesTable.ts';
import { CohortsTable } from './mining-db/CohortsTable.ts';
import { FramesTable } from './mining-db/FramesTable.ts';
import { miningMigrations } from './mining-db/migrations/index.ts';

export class MiningDb {
  public readonly sql: DatabaseSync;
  public readonly frames: FramesTable;
  public readonly cohorts: CohortsTable;
  public readonly cohortFrames: CohortFramesTable;

  constructor(datadir: string) {
    mkdirSync(datadir, { recursive: true });
    this.sql = new DatabaseSync(join(datadir, 'mining.db'));
    this.frames = new FramesTable(this);
    this.cohorts = new CohortsTable(this);
    this.cohortFrames = new CohortFramesTable(this);
  }

  public migrate(): void {
    runSqliteMigrations(this.sql, miningMigrations);
  }

  public close(): void {
    this.sql.close();
  }
}
