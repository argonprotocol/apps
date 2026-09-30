import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectStartingDatabase,
  isStartingDatabaseComplete,
  type StartingDatabaseInspection,
} from '../local-mainnet/StartingDatabaseInspection.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('starting database capture', () => {
  it('requires every recovery domain to reach the pinned block without partial or pending work', () => {
    const complete: StartingDatabaseInspection = {
      quickCheck: 'ok',
      walletHistoryThroughBlock: 100,
      financialDomains: ['bitcoin', 'bonds', 'vaulting'],
      partialFinancialDomains: [],
      pendingBitcoinLocks: 0,
      bitcoinLiquidIds: [],
      archivedBitcoinLiquidIds: [],
      bondLotIds: [],
      stakeLotIds: [],
      configuredServer: false,
      operations: false,
      treasury: false,
      upstream: false,
    };

    expect(isStartingDatabaseComplete(complete, 100)).toBe(true);
    expect(isStartingDatabaseComplete({ ...complete, walletHistoryThroughBlock: 99 }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, financialDomains: ['bitcoin', 'bonds'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, partialFinancialDomains: ['vaulting'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, pendingBitcoinLocks: 1 }, 100)).toBe(false);
  });

  it('captures current and archived Liquids without requiring pre-cutover Bitcoin columns', () => {
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-current-history-'));
    directories.push(directory);
    const path = Path.join(directory, 'database.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE BitcoinLocks (lockId INTEGER, isHistoryRecoveryPending INTEGER);
      CREATE TABLE BitcoinFissions (ownerAccount TEXT, liquidId INTEGER, closedAtArgonBlock INTEGER);
      INSERT INTO BitcoinFissions VALUES
        ('account', 1, 90), ('account', 2, 90), ('account', 2, NULL),
        ('account', 3, NULL), ('other-account', 4, 90);
      CREATE TABLE SyncState (key INTEGER, state TEXT);
      CREATE TABLE BondLotHistory (accountId TEXT, programType TEXT, bondLotId INTEGER, releaseBlockHash TEXT);
      CREATE TABLE Config (key TEXT, value TEXT);
    `);
    database.close();

    const inspection = inspectStartingDatabase(path, 100, 'account');
    expect(inspection.bitcoinLiquidIds).toEqual([1, 2, 3]);
    expect(inspection.archivedBitcoinLiquidIds).toEqual([1]);
    expect(inspection.pendingBitcoinLocks).toBe(0);
    expect(isStartingDatabaseComplete(inspection, 100)).toBe(false);
  });
});
