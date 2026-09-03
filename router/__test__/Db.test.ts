import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteMigrations, UserRole } from '@argonprotocol/apps-core';
import { Db } from '../src/Db.ts';
import { migrations } from '../src/db/migrations/index.ts';

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
          role: UserRole.Member,
          name: 'Casey',
        });

        await Promise.resolve();
      }),
    ).toThrowError('Db.transaction callback must be synchronous.');

    expect(testDb.usersTable.fetchByRole(UserRole.Member)).toEqual([]);
  });

  it('adds the Lock identity to existing coupon-use databases', () => {
    const testDb = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-db-')), 'router.sqlite'));
    db = testDb;
    runSqliteMigrations(testDb.sql, migrations.slice(0, -1));

    const columnsBeforeUpgrade = testDb.sql.prepare('PRAGMA table_info(BitcoinLockCouponUses)').all();
    expect(columnsBeforeUpgrade.some(column => column.name === 'utxoId')).toBe(false);

    testDb.migrate();

    const columnsAfterUpgrade = testDb.sql.prepare('PRAGMA table_info(BitcoinLockCouponUses)').all();
    expect(columnsAfterUpgrade.some(column => column.name === 'utxoId')).toBe(true);
  });
});
