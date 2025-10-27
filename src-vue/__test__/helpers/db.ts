import { Db } from '../../lib/Db';
import { IConfigStringified } from '../../interfaces/IConfig';
import { open } from 'sqlite';
import { Database as Sqlite3Database } from 'sqlite3';
import PluginSql, { QueryResult } from '@tauri-apps/plugin-sql';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';

export async function createMockedDbPromise(allAsObject: { [key: string]: string } = {}): Promise<Db> {
  return {
    configTable: {
      fetchAllAsObject: async () => allAsObject,
      insertOrReplace: async (obj: Partial<IConfigStringified>) => {},
    },
  } as unknown as Db;
}

export async function createTestDb(): Promise<Db> {
  const database = await open({
    filename: ':memory:',
    driver: Sqlite3Database,
  });

  const baseDir = Path.resolve(__dirname, '../../../src-tauri/migrations');
  const migrations = await readdir(baseDir);
  for (const migration of migrations) {
    const upFile = Path.join(baseDir, migration, 'up.sql');
    console.log('Migrating', upFile);
    const upContent = await readFile(upFile, 'utf8');
    await database.exec(upContent);
  }

  const plugin = {
    async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
      console.log('execute value', query);
      const result = await database.run(query, ...(bindValues ?? []));
      return {
        lastInsertId: result.lastID,
        rowsAffected: result.changes ?? 0,
      };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      console.log('Selecting value', query);
      return (await database.all(query, ...(bindValues ?? []))) as T;
    },
    async close(_db?: string): Promise<boolean> {
      await database.close();
      return true;
    },
  } as PluginSql;
  return new Db(plugin, false);
}
