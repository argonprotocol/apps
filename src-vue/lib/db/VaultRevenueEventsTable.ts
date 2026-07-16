import { BaseTable, type IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';

export interface IVaultRevenueEventsRecord {
  id: number;
  amount: bigint;
  source: 'vaultCollect' | 'vaultBurn';
  blockNumber: number;
  blockHash: string;
  blockTime?: Date;
  extrinsicIndex?: number;
  createdAt: Date;
  updatedAt: Date;
}

export class VaultRevenueEventsTable extends BaseTable {
  public revision = 0;

  private fields: IFieldTypes = {
    bigint: ['amount'],
    date: ['blockTime', 'createdAt', 'updatedAt'],
  };

  public async insert(
    args: Omit<IVaultRevenueEventsRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IVaultRevenueEventsRecord | undefined> {
    const { amount, source, blockNumber, blockHash, blockTime, extrinsicIndex } = args;
    const records = await this.db.select<IVaultRevenueEventsRecord[]>(
      `INSERT INTO VaultRevenueEvents
        (amount, source, blockNumber, blockHash, blockTime, extrinsicIndex)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          blockTime = COALESCE(VaultRevenueEvents.blockTime, excluded.blockTime),
          extrinsicIndex = COALESCE(VaultRevenueEvents.extrinsicIndex, excluded.extrinsicIndex)
        WHERE (VaultRevenueEvents.blockTime IS NULL AND excluded.blockTime IS NOT NULL)
           OR (VaultRevenueEvents.extrinsicIndex IS NULL AND excluded.extrinsicIndex IS NOT NULL)
        RETURNING *;`,
      toSqlParams([amount, source, blockNumber, blockHash, blockTime, extrinsicIndex]),
    );
    const record = convertFromSqliteFields<IVaultRevenueEventsRecord[]>(records, this.fields)[0];
    if (record) this.revision += 1;
    return record;
  }

  public async fetchAll(): Promise<IVaultRevenueEventsRecord[]> {
    const records = await this.db.select<IVaultRevenueEventsRecord[]>(
      `SELECT * FROM VaultRevenueEvents
       ORDER BY blockNumber, id`,
    );
    return convertFromSqliteFields<IVaultRevenueEventsRecord[]>(records, this.fields);
  }
}
