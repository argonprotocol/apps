import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';

export interface IVaultRevenueEventsRecord {
  id: number;
  amount: bigint;
  source: 'vaultCollect' | 'vaultBurn';
  blockNumber: number;
  blockHash: string;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IVaultRevenueEventsRecordKey = keyof IVaultRevenueEventsRecord & string;
export class VaultRevenueEventsTable extends BaseTable {
  private bigIntFields: IVaultRevenueEventsRecordKey[] = ['amount'];
  private dateFields: IVaultRevenueEventsRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: IVaultRevenueEventsRecordKey[] = [];
  private booleanFields: IVaultRevenueEventsRecordKey[] = [];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
      boolean: this.booleanFields,
    };
  }

  public async insert(
    args: Omit<IVaultRevenueEventsRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IVaultRevenueEventsRecord | undefined> {
    const { amount, source, blockNumber, blockHash } = args;
    const records = await this.db.select<IVaultRevenueEventsRecord[]>(
      `INSERT INTO VaultRevenueEvents
        (amount, source, blockNumber, blockHash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(amount, source, blockHash) DO NOTHING
        RETURNING *;`,
      toSqlParams([amount, source, blockNumber, blockHash]),
    );
    return convertFromSqliteFields<IVaultRevenueEventsRecord[]>(records, this.fields)[0];
  }

  public async deleteBlock(blockHash: string): Promise<void> {
    await this.db.execute(`DELETE FROM VaultRevenueEvents WHERE blockHash = ?`, toSqlParams([blockHash]));
  }
}
