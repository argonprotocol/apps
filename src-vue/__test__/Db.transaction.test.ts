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

  it('routes only statements carrying the transaction id through the transaction commands', async () => {
    pluginExecute.mockResolvedValue({ rowsAffected: 1 });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 17;
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
    expect(pluginExecute).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls).toEqual([
      ['sql_begin_transaction', { db: 'sqlite:test.sqlite' }],
      [
        'sql_execute',
        {
          transactionId: 17,
          query: 'INSERT INTO recovery_units (state) VALUES (?)',
          values: ['pending'],
        },
      ],
      ['sql_select', { transactionId: 17, query: 'SELECT state FROM recovery_units', values: [] }],
      ['sql_commit_transaction', { transactionId: 17 }],
    ]);
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

    expect(invoke).toHaveBeenLastCalledWith('sql_rollback_transaction', { transactionId: 23 });
    expect(invoke).not.toHaveBeenCalledWith('sql_commit_transaction', expect.anything());
  });

  it('uses the root table state in the transaction-bound table instances', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'sql_begin_transaction') return 31;
    });
    db.walletTransfersTable.revision = 4;

    await db.transaction(async transaction => {
      expect(transaction.walletTransfersTable).not.toBe(db.walletTransfersTable);
      expect(transaction.walletTransfersTable.state).toBe(db.walletTransfersTable.state);
      expect(transaction.walletTransfersTable.revision).toBe(4);
    });

    expect(db.walletTransfersTable.revision).toBe(4);
  });
});
