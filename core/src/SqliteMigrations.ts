import type { DatabaseSync } from 'node:sqlite';

export type ISqliteMigration = (db: DatabaseSync) => void;

export function runSqliteMigrations(db: DatabaseSync, migrations: ISqliteMigration[]): void {
  db.exec('PRAGMA foreign_keys = ON');

  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version > migrations.length) {
    throw new Error(`Database schema version ${user_version} is newer than this app supports (${migrations.length}).`);
  }

  for (const [index, migrate] of migrations.entries()) {
    const version = index + 1;
    if (version <= user_version) continue;

    db.exec('BEGIN');
    try {
      migrate(db);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
