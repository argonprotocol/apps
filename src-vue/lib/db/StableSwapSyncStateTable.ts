import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export interface IStableSwapSyncStateRecord {
  walletAddress: string;
  startBlockNumber: number;
  lastScannedBlockNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

type IStableSwapSyncStateRecordKey = keyof IStableSwapSyncStateRecord;

export class StableSwapSyncStateTable extends BaseTable {
  private dateFields: IStableSwapSyncStateRecordKey[] = ['createdAt', 'updatedAt'];

  private get fields(): IFieldTypes {
    return {
      date: this.dateFields,
    };
  }

  public async get(walletAddress: string): Promise<IStableSwapSyncStateRecord | null> {
    const records = await this.db.select<IStableSwapSyncStateRecord[]>(
      `SELECT * FROM StableSwapSyncState WHERE walletAddress = ? LIMIT 1`,
      [walletAddress],
    );
    return convertFromSqliteFields<IStableSwapSyncStateRecord[]>(records, this.fields)[0] ?? null;
  }

  public async upsert(
    args: Pick<IStableSwapSyncStateRecord, 'walletAddress' | 'startBlockNumber' | 'lastScannedBlockNumber'>,
  ): Promise<IStableSwapSyncStateRecord | undefined> {
    const { walletAddress, startBlockNumber, lastScannedBlockNumber } = args;
    const records = await this.db.select<IStableSwapSyncStateRecord[]>(
      `INSERT INTO StableSwapSyncState (walletAddress, startBlockNumber, lastScannedBlockNumber)
         VALUES (?, ?, ?)
         ON CONFLICT(walletAddress) DO UPDATE SET
           startBlockNumber = excluded.startBlockNumber,
           lastScannedBlockNumber = excluded.lastScannedBlockNumber,
           updatedAt = CURRENT_TIMESTAMP
         RETURNING *`,
      toSqlParams([walletAddress, startBlockNumber, lastScannedBlockNumber]),
    );
    return convertFromSqliteFields<IStableSwapSyncStateRecord[]>(records, this.fields)[0];
  }
}
