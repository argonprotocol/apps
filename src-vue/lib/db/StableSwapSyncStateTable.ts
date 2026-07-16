import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export interface IStableSwapSyncStateRecord {
  walletAddress: string;
  startBlockNumber: number;
  lastScannedBlockNumber: number;
  isPurchaseBasisIntact: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class StableSwapSyncStateTable extends BaseTable {
  private fields: IFieldTypes = {
    boolean: ['isPurchaseBasisIntact'] satisfies (keyof IStableSwapSyncStateRecord)[],
    date: ['createdAt', 'updatedAt'] satisfies (keyof IStableSwapSyncStateRecord)[],
  };

  public async get(walletAddress: string): Promise<IStableSwapSyncStateRecord | null> {
    const records = await this.db.select<IStableSwapSyncStateRecord[]>(
      `SELECT * FROM StableSwapSyncState WHERE walletAddress = ? LIMIT 1`,
      [walletAddress],
    );
    return convertFromSqliteFields<IStableSwapSyncStateRecord[]>(records, this.fields)[0] ?? null;
  }

  public async upsert(
    args: Pick<
      IStableSwapSyncStateRecord,
      'walletAddress' | 'startBlockNumber' | 'lastScannedBlockNumber' | 'isPurchaseBasisIntact'
    >,
  ): Promise<IStableSwapSyncStateRecord | undefined> {
    const { walletAddress, startBlockNumber, lastScannedBlockNumber, isPurchaseBasisIntact } = args;
    const records = await this.db.select<IStableSwapSyncStateRecord[]>(
      `INSERT INTO StableSwapSyncState
         (walletAddress, startBlockNumber, lastScannedBlockNumber, isPurchaseBasisIntact)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(walletAddress) DO UPDATE SET
           startBlockNumber = excluded.startBlockNumber,
           lastScannedBlockNumber = excluded.lastScannedBlockNumber,
           isPurchaseBasisIntact = StableSwapSyncState.isPurchaseBasisIntact AND excluded.isPurchaseBasisIntact,
           updatedAt = CURRENT_TIMESTAMP
         RETURNING *`,
      toSqlParams([walletAddress, startBlockNumber, lastScannedBlockNumber, isPurchaseBasisIntact]),
    );
    return convertFromSqliteFields<IStableSwapSyncStateRecord[]>(records, this.fields)[0];
  }
}
