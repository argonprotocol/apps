import { IConfigStringified } from '../../interfaces/IConfig';
import { Db } from '../../lib/Db';
import PluginSql, { QueryResult } from '@tauri-apps/plugin-sql';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { JsonExt } from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';

const shouldLogDbQueries = process.env.TEST_DB_DEBUG === '1';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
let migrationSqlStatementsPromise: Promise<string[]> | null = null;

export async function createTestDb(): Promise<Db> {
  const database = new TestSqliteDb(':memory:');
  const migrationSqlStatements = await getMigrationSqlStatements();
  for (const migrationSql of migrationSqlStatements) {
    await database.exec(migrationSql);
  }

  const plugin = {
    async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
      if (shouldLogDbQueries) {
        console.log('execute value', query);
      }
      const result = await database.run(query, bindValues);
      return {
        lastInsertId: result.lastID,
        rowsAffected: result.changes ?? 0,
      };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      if (shouldLogDbQueries) {
        console.log('Selecting value', query);
      }
      return (await database.all<T>(query, bindValues)) as T;
    },
    async close(_db?: string): Promise<boolean> {
      await database.close();
      return true;
    },
  } as PluginSql;

  return new Db(plugin, false);
}

export class TestSqliteDb {
  readonly #database: DatabaseSync;

  constructor(filename: string = ':memory:') {
    this.#database = new DatabaseSync(filename);
  }

  public async exec(query: string): Promise<void> {
    this.#database.exec(query);
  }

  public async run(query: string, bindValues?: unknown[]): Promise<{ lastID: number; changes: number }> {
    const result = this.#database.prepare(query).run(...toNodeSqliteParams(bindValues));
    return {
      lastID: Number(result.lastInsertRowid),
      changes: Number(result.changes ?? 0),
    };
  }

  public async all<T>(query: string, bindValues?: unknown[]): Promise<T> {
    return this.#database.prepare(query).all(...toNodeSqliteParams(bindValues)) as T;
  }

  public async get<T>(query: string, bindValues?: unknown[]): Promise<T> {
    return this.#database.prepare(query).get(...toNodeSqliteParams(bindValues)) as T;
  }

  public async close(): Promise<void> {
    this.#database.close();
  }
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

        try {
          statements.push(await readFile(upFile, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw error;
        }
      }

      return statements;
    })
    .catch(error => {
      migrationSqlStatementsPromise = null;
      throw error;
    }));
}

function toNodeSqliteParams(bindValues?: unknown[]): (string | number | Uint8Array | null)[] {
  return (bindValues ?? []).map(param => {
    if (param === undefined || param === null) {
      return null;
    }
    if (typeof param === 'boolean') {
      return param ? 1 : 0;
    }
    if (typeof param === 'bigint') {
      return param.toString();
    }
    if (param instanceof Date) {
      return param.toISOString();
    }
    if (ArrayBuffer.isView(param)) {
      return u8aToHex(new Uint8Array(param.buffer, param.byteOffset, param.byteLength));
    }
    if (typeof param === 'object') {
      return JsonExt.stringify(param);
    }
    return param as string | number | Uint8Array;
  });
}

export async function createMockedDbPromise(allAsObject: { [key: string]: string } = {}): Promise<Db> {
  return Object.assign(Object.create(Db.prototype), {
    configTable: {
      fetchAllAsObject: async () => allAsObject,
      insertOrReplace: async (obj: Partial<IConfigStringified>) => {},
    },
    vaultsTable: {
      get: async () => undefined,
    },
  }) as Db;
}
