import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export enum TransactionHistoryStatus {
  Submitted = 'Submitted',
  Broadcast = 'Broadcast',
  InBlock = 'InBlock',
  Finalized = 'Finalized',
  Error = 'Error',
  TimedOutWaitingForBlock = 'TimedOutWaitingForBlock',
  Retracted = 'Retracted',
  Dropped = 'Dropped',
  Usurped = 'Usurped',
  Invalid = 'Invalid',
}

export enum TransactionHistorySource {
  Local = 'Local',
  Watch = 'Watch',
  Block = 'Block',
}

export interface ITransactionStatusHistoryRecord {
  id: number;
  transactionId: number;
  status: TransactionHistoryStatus;
  source: TransactionHistorySource;
  blockHeight?: number;
  blockHash?: string;
  replacementTxHash?: string;
  createdAt: Date;
}

export class TransactionStatusHistoryTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    date: ['createdAt'],
  };

  public async fetchByTransactionId(transactionId: number): Promise<ITransactionStatusHistoryRecord[]> {
    const records = await this.db.select<ITransactionStatusHistoryRecord[]>(
      `SELECT id, transactionId, status, source, blockHeight, blockHash, replacementTxHash, createdAt
       FROM TransactionStatusHistory
       WHERE transactionId = ?
       ORDER BY createdAt ASC, id ASC`,
      toSqlParams([transactionId]),
    );
    return convertFromSqliteFields<ITransactionStatusHistoryRecord[]>(records, this.fieldTypes);
  }

  public async fetchLatestByTransactionIds(
    transactionIds: number[],
  ): Promise<Map<number, ITransactionStatusHistoryRecord>> {
    if (!transactionIds.length) return new Map();

    const placeholders = transactionIds.map(() => '?').join(', ');
    const records = await this.db.select<ITransactionStatusHistoryRecord[]>(
      `SELECT h.id, h.transactionId, h.status, h.source, h.blockHeight, h.blockHash, h.replacementTxHash, h.createdAt
       FROM TransactionStatusHistory h
       INNER JOIN (
         SELECT transactionId, MAX(id) AS id
         FROM TransactionStatusHistory
         WHERE transactionId IN (${placeholders})
         GROUP BY transactionId
       ) latest ON latest.id = h.id
      ORDER BY h.transactionId ASC`,
      toSqlParams(transactionIds),
    );
    const convertedRecords = convertFromSqliteFields<ITransactionStatusHistoryRecord[]>(records, this.fieldTypes);

    return new Map(
      convertedRecords.map(record => {
        return [record.transactionId, record] as const;
      }),
    );
  }

  public async record(
    entry: Omit<ITransactionStatusHistoryRecord, 'id' | 'createdAt'>,
  ): Promise<ITransactionStatusHistoryRecord | undefined> {
    const latestRecords = await this.db.select<ITransactionStatusHistoryRecord[]>(
      `SELECT id, transactionId, status, source, blockHeight, blockHash, replacementTxHash, createdAt
         FROM TransactionStatusHistory
         WHERE transactionId = ?
         ORDER BY createdAt DESC, id DESC
         LIMIT 1`,
      toSqlParams([entry.transactionId]),
    );
    const latest = convertFromSqliteFields<ITransactionStatusHistoryRecord[]>(latestRecords, this.fieldTypes)[0];

    if (
      latest &&
      latest.status === entry.status &&
      latest.source === entry.source &&
      latest.blockHeight === entry.blockHeight &&
      latest.blockHash === entry.blockHash &&
      latest.replacementTxHash === entry.replacementTxHash
    ) {
      return latest;
    }

    const records = await this.db.select<ITransactionStatusHistoryRecord[]>(
      `INSERT INTO TransactionStatusHistory (
          transactionId, status, source, blockHeight, blockHash, replacementTxHash
        ) VALUES (
          ?, ?, ?, ?, ?, ?
        ) RETURNING id, transactionId, status, source, blockHeight, blockHash, replacementTxHash, createdAt`,
      toSqlParams([
        entry.transactionId,
        entry.status,
        entry.source,
        entry.blockHeight,
        entry.blockHash,
        entry.replacementTxHash,
      ]),
    );
    const convertedRecords = convertFromSqliteFields<ITransactionStatusHistoryRecord[]>(records, this.fieldTypes);
    return convertedRecords[0];
  }
}
