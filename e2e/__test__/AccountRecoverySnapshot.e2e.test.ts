import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRecoverySnapshot } from '../local-mainnet/AccountRecoverySnapshot.ts';

describe('account recovery snapshots', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('ignores observation timestamps but detects changed durable financial state', () => {
    const directory = mkdtempSync(Path.join(os.tmpdir(), 'account-recovery-snapshot-'));
    temporaryDirectories.push(directory);
    const databasePath = Path.join(directory, 'database.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE PositionHistory (
        id INTEGER PRIMARY KEY,
        amount INTEGER NOT NULL,
        state TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO PositionHistory (id, amount, state, updatedAt)
      VALUES (1, 1200, '{"asOfBlock":42,"updatedAt":"first"}', 'first');
      CREATE TABLE Config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO Config (key, value, updatedAt)
      VALUES ('postWelcomeLaunchCount', '1', 'first');
      CREATE TABLE BitcoinUtxos (
        id INTEGER PRIMARY KEY,
        satoshis TEXT NOT NULL,
        mempoolObservation TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO BitcoinUtxos (id, satoshis, mempoolObservation, updatedAt)
      VALUES (1, '5000', '{"confirmations":1,"txid":"tx-1"}', 'first');
    `);
    database.close();

    const financials = {
      readiness: 'ready',
      isStale: false,
      grossAssets: 1200n,
      grossLiabilities: 0n,
      netWorth: 1200n,
      accountReturn: {
        availability: 'available',
        basisPoints: 250n,
        percent: 2.5,
        eligiblePositionCount: 1,
        investmentPositionCount: 1,
      },
      groups: [
        {
          group: 'bitcoin',
          observation: { blockNumber: 42, observedAt: new Date('2026-09-21T12:00:00Z') },
          positions: [{ id: 'bitcoin:1', startedAt: new Date('2026-09-20T12:00:00Z') }],
        },
      ],
    };
    const first = AccountRecoverySnapshot.capture({ databasePath, financials });

    const timestampUpdate = new DatabaseSync(databasePath);
    timestampUpdate.exec(
      `UPDATE PositionHistory SET updatedAt = 'second', state = '{"updatedAt":"second","asOfBlock":42}';
       UPDATE Config SET value = '2', updatedAt = 'second' WHERE key = 'postWelcomeLaunchCount';
       UPDATE BitcoinUtxos
       SET mempoolObservation = '{"confirmations":2,"txid":"tx-1"}', updatedAt = 'second'
       WHERE id = 1;`,
    );
    timestampUpdate.close();
    const second = AccountRecoverySnapshot.capture({
      databasePath,
      financials: {
        ...financials,
        groups: [
          {
            group: 'bitcoin',
            observation: { blockNumber: 42, observedAt: new Date('2026-09-21T12:01:00Z') },
            positions: [{ id: 'bitcoin:1', startedAt: new Date('2026-09-20T12:00:00Z') }],
          },
        ],
      },
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(first, second, 'retry')).not.toThrow();

    const financialUpdate = new DatabaseSync(databasePath);
    financialUpdate.exec('UPDATE PositionHistory SET amount = 1300');
    financialUpdate.close();
    const third = AccountRecoverySnapshot.capture({
      databasePath,
      financials: { ...financials, grossAssets: 1300n, netWorth: 1300n },
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(second, third, 'retry')).toThrow(
      /financial projection .*grossAssets.*netWorth.*table PositionHistory .*amount/,
    );

    const changedDate = AccountRecoverySnapshot.capture({
      databasePath,
      financials: {
        ...financials,
        groups: [
          {
            group: 'bitcoin',
            observation: { blockNumber: 42, observedAt: new Date('2026-09-21T12:02:00Z') },
            positions: [{ id: 'bitcoin:1', startedAt: new Date('2026-09-20T12:01:00Z') }],
          },
        ],
      },
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(first, changedDate, 'retry')).toThrow(
      /financial projection .*startedAt.*table PositionHistory .*amount/,
    );
  });
});
