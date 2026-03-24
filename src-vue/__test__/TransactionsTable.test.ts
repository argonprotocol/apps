import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TransactionHistorySource, TransactionHistoryStatus } from '../lib/db/TransactionStatusHistoryTable.ts';

async function createRecord(overrides: Partial<ITransactionRecord> = {}) {
  const db = await createTestDb();
  const table = db.transactionsTable;
  const record = await table.insert({
    extrinsicHash: overrides.extrinsicHash ?? '0x1234',
    extrinsicMethodJson: overrides.extrinsicMethodJson ?? {
      section: 'balances',
      method: 'transferAllowDeath',
    },
    metadataJson: overrides.metadataJson ?? { testId: 1 },
    extrinsicType: overrides.extrinsicType ?? ExtrinsicType.Transfer,
    accountAddress: overrides.accountAddress ?? '5F3sa2TJAWMqDhXG6jhV4N8ko9Y3xw9A7LE2rY9uUZYqW7z9',
    submittedAtBlockHeight: overrides.submittedAtBlockHeight ?? 100,
    submittedAtTime: overrides.submittedAtTime ?? new Date('2026-03-20T20:05:00Z'),
    txNonce: overrides.txNonce ?? 7,
  });
  return { db, table, record };
}

describe('TransactionsTable', () => {
  it('stores the signed nonce and initial submitted history', async () => {
    const { table, record } = await createRecord({ txNonce: 11 });

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    const history = await table.fetchStatusHistory(record.id);

    expect(updated.txNonce).toBe(11);
    expect(history.map(({ status, source }) => [status, source])).toEqual([
      [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
    ]);
    expect(history[0].createdAt).toBeInstanceOf(Date);
  });

  it('records block and finalized history without changing the transaction block hash semantics', async () => {
    const { table, record } = await createRecord();

    await table.recordInBlock(record, {
      blockNumber: 101,
      blockHash: '0xabc',
      blockTime: new Date('2026-03-20T20:06:00Z'),
      tip: 2n,
      feePlusTip: 5n,
      extrinsicIndex: 3,
      transactionEvents: [],
    });

    await table.markFinalized(record, {
      blockNumber: 106,
      blockTime: new Date('2026-03-20T20:11:00Z'),
    });

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    const history = await table.fetchStatusHistory(record.id);

    expect(updated.status).toBe(TransactionStatus.Finalized);
    expect(updated.isFinalized).toBe(true);
    expect(updated.blockHeight).toBe(101);
    expect(updated.blockHash).toBe('0xabc');
    expect(updated.finalizedHeadHeight).toBe(106);
    expect(updated.txTip).toBe(2n);
    expect(updated.txFeePlusTip).toBe(5n);
    expect(history.map(({ status, source }) => [status, source])).toEqual([
      [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
      [TransactionHistoryStatus.InBlock, TransactionHistorySource.Block],
      [TransactionHistoryStatus.Finalized, TransactionHistorySource.Block],
    ]);
    expect(history[1].blockHash).toBe('0xabc');
    expect(history[2].blockHash).toBeNull();
    expect(history[2].blockHeight).toBe(106);
  });

  it('records submission errors in transaction history', async () => {
    const { table, record } = await createRecord();

    await table.recordSubmissionError(record, new Error('No provider'));

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    const history = await table.fetchStatusHistory(record.id);

    expect(updated.status).toBe(TransactionStatus.Error);
    expect(updated.submissionErrorJson?.message).toBe('No provider');
    expect(history.map(({ status, source }) => [status, source])).toEqual([
      [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
      [TransactionHistoryStatus.Error, TransactionHistorySource.Local],
    ]);
  });

  it('records timeout history when a transaction expires waiting for a block', async () => {
    const { table, record } = await createRecord();

    await table.markExpiredWaitingForBlock(record);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    const history = await table.fetchStatusHistory(record.id);

    expect(updated.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
    expect(history.map(({ status, source }) => [status, source])).toEqual([
      [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
      [TransactionHistoryStatus.TimedOutWaitingForBlock, TransactionHistorySource.Local],
    ]);
  });
});
