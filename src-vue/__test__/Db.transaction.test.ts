import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginSql from '@tauri-apps/plugin-sql';
import { Db } from '../lib/Db.ts';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('Db transactions', () => {
  const pluginExecute = vi.fn();
  const pluginSelect = vi.fn();
  let db: Db;

  beforeEach(() => {
    invoke.mockReset();
    pluginExecute.mockReset();
    pluginSelect.mockReset();
    db = new Db(
      {
        path: 'sqlite:test.sqlite',
        execute: pluginExecute,
        select: pluginSelect,
      } as unknown as PluginSql,
      false,
    );
  });

  it('routes all writes through the shared writer while preserving transaction ids', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 17;
      if (command === 'sql_execute_write') return { rowsAffected: 1, lastInsertId: 0 };
      if (command === 'sql_execute') return { rowsAffected: 1, lastInsertId: 4 };
      if (command === 'sql_select') return [{ state: 'pending', completedAt: null }];
    });

    await db.execute('UPDATE outside_transaction SET state = ?', ['ready']);
    const result = await db.transaction(async transaction => {
      await transaction.execute('INSERT INTO recovery_units (state) VALUES (?)', ['pending']);
      await db.execute('UPDATE still_outside SET state = ?', ['ready']);
      return transaction.select<{ state: string }[]>('SELECT state FROM recovery_units', []);
    });

    expect(result).toEqual([{ state: 'pending' }]);
    expect(pluginExecute).not.toHaveBeenCalled();
    const sessionId = invoke.mock.calls[1][1].sessionId;
    expect(sessionId).toEqual(expect.any(String));
    expect(invoke.mock.calls).toEqual([
      [
        'sql_execute_write',
        { db: 'sqlite:test.sqlite', query: 'UPDATE outside_transaction SET state = ?', values: ['ready'] },
      ],
      ['sql_begin_transaction', { db: 'sqlite:test.sqlite', sessionId }],
      [
        'sql_execute',
        {
          sessionId,
          transactionId: 17,
          query: 'INSERT INTO recovery_units (state) VALUES (?)',
          values: ['pending'],
        },
      ],
      [
        'sql_execute_write',
        { db: 'sqlite:test.sqlite', query: 'UPDATE still_outside SET state = ?', values: ['ready'] },
      ],
      ['sql_select', { sessionId, transactionId: 17, query: 'SELECT state FROM recovery_units', values: [] }],
      ['sql_commit_transaction', { sessionId, transactionId: 17 }],
    ]);
  });

  it('serializes write statements returning rows without routing reads through the writer', async () => {
    invoke.mockResolvedValue([{ id: 4, completedAt: null }]);
    pluginSelect.mockResolvedValue([{ id: 4, completedAt: null }]);

    await expect(
      db.select<{ id: number }[]>('  UPDATE recovery_units SET state = ? RETURNING id, completedAt', ['ready']),
    ).resolves.toEqual([{ id: 4 }]);
    await expect(db.select<{ id: number }[]>('WITH rows AS (SELECT 4 AS id) SELECT id FROM rows')).resolves.toEqual([
      { id: 4 },
    ]);

    expect(invoke).toHaveBeenCalledWith('sql_select_write', {
      db: 'sqlite:test.sqlite',
      query: '  UPDATE recovery_units SET state = ? RETURNING id, completedAt',
      values: ['ready'],
    });
    expect(pluginSelect).toHaveBeenCalledOnce();
  });

  it('rolls back the transaction when its callback fails', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 23;
      if (command === 'sql_execute') return { rowsAffected: 1 };
    });

    const failure = new Error('second write failed');
    await expect(
      db.transaction(async transaction => {
        await transaction.execute('INSERT INTO recovery_units (state) VALUES (?)', ['pending']);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(invoke).toHaveBeenLastCalledWith('sql_rollback_transaction', {
      sessionId: expect.any(String),
      transactionId: 23,
    });
    expect(invoke).not.toHaveBeenCalledWith('sql_commit_transaction', expect.anything());
  });

  it('shares table caches but publishes changes only after a successful commit', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 31;
      if (command === 'sql_execute') return { rowsAffected: 1 };
    });
    db.walletTransfersTable.revision = 4;
    const earnings = {
      frameId: 12,
      cohortActivationFrameId: 11,
      blocksMinedTotal: 1,
      micronotsMinedTotal: 0n,
      microgonsMinedTotal: 10n,
      microgonsMintedTotal: 0n,
      microgonFeesCollectedTotal: 0n,
    };

    await db.transaction(async transaction => {
      expect(transaction.walletTransfersTable).not.toBe(db.walletTransfersTable);
      expect(transaction.walletTransfersTable.state).toBe(db.walletTransfersTable.state);
      expect(transaction.walletTransfersTable.revision).toBe(4);
      await transaction.cohortFramesTable.insertOrUpdate(earnings);
      expect(db.cohortFramesTable.state.cache.get('12:11')).toBeUndefined();
    });

    expect(db.walletTransfersTable.revision).toBe(4);
    expect(db.cohortFramesTable.state.cache.get('12:11')?.microgonsMinedTotal).toBe(10n);

    const failure = new Error('commit failed');
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 32;
      if (command === 'sql_execute') return { rowsAffected: 1 };
      if (command === 'sql_commit_transaction') throw failure;
    });
    await expect(
      db.transaction(transaction =>
        transaction.cohortFramesTable.insertOrUpdate({ ...earnings, microgonsMinedTotal: 20n }),
      ),
    ).rejects.toBe(failure);
    expect(db.cohortFramesTable.state.cache.get('12:11')?.microgonsMinedTotal).toBe(10n);
  });
});
