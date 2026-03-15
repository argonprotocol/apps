import { Db } from '../../lib/Db';
import { IConfigStringified } from '../../interfaces/IConfig';
import { open } from 'sqlite';
import { Database as Sqlite3Database } from 'sqlite3';
import PluginSql, { QueryResult } from '@tauri-apps/plugin-sql';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';

const shouldLogDbQueries = process.env.TEST_DB_DEBUG === '1';
let migrationSqlStatementsPromise: Promise<string[]> | null = null;

export async function createMockedDbPromise(allAsObject: { [key: string]: string } = {}): Promise<Db> {
  return Object.assign(Object.create(Db.prototype), {
    configTable: {
      fetchAllAsObject: async () => allAsObject,
      insertOrReplace: async (obj: Partial<IConfigStringified>) => {},
    },
  }) as Db;
}

export async function createTestDb(): Promise<Db> {
  const database = await open({
    filename: ':memory:',
    driver: Sqlite3Database,
  });

  const migrationSqlStatements = await getMigrationSqlStatements();
  for (const migrationSql of migrationSqlStatements) {
    await database.exec(migrationSql);
  }

  const plugin = {
    async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
      if (shouldLogDbQueries) {
        console.log('execute value', query);
      }
      const result = await database.run(query, ...(bindValues ?? []));
      return {
        lastInsertId: result.lastID,
        rowsAffected: result.changes ?? 0,
      };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      if (shouldLogDbQueries) {
        console.log('Selecting value', query);
      }
      return (await database.all(query, ...(bindValues ?? []))) as T;
    },
    async close(_db?: string): Promise<boolean> {
      await database.close();
      return true;
    },
  } as PluginSql;
  return new Db(plugin, false);
}

async function getMigrationSqlStatements(): Promise<string[]> {
  return (migrationSqlStatementsPromise ??= Promise.resolve()
    .then(async () => {
      const baseDir = Path.resolve(__dirname, '../../../src-tauri/migrations');
      const migrations = (await readdir(baseDir)).sort((a, b) => a.localeCompare(b));
      const statements: string[] = [];
      for (const migration of migrations) {
        const upFile = Path.join(baseDir, migration, 'up.sql');
        if (shouldLogDbQueries) {
          console.log('Migrating', upFile);
        }
        statements.push(await readFile(upFile, 'utf8'));
      }
      return statements;
    })
    .catch(error => {
      migrationSqlStatementsPromise = null;
      throw error;
    }));
}
