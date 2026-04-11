import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/Db.ts';

describe('Db', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('rejects async transaction callbacks and rolls back their writes', () => {
    const testDb = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-db-')), 'router.sqlite'));
    db = testDb;
    testDb.migrate();

    expect(() =>
      testDb.transaction(async () => {
        testDb.usersTable.insertUser({
          role: 'treasury_user',
          name: 'Casey',
        });

        await Promise.resolve();
      }),
    ).toThrowError('Db.transaction callback must be synchronous.');

    expect(testDb.usersTable.fetchByRole('treasury_user')).toEqual([]);
  });
});
