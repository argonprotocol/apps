import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';

export interface IVaultRecord {
  id: number;
  hdPath: string;
  createdAtBlockHeight: number;
  lastTermsUpdateHeight?: number;
  operationalFeeMicrogons?: bigint;
  isClosed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class VaultsTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    date: ['createdAt', 'updatedAt'],
    bigint: ['prebondedMicrogons', 'operationalFeeMicrogons'],
  };

  public async insert(
    vaultId: number,
    hdPath: string,
    updatedAtBlockHeight: number,
    operationalFeeMicrogons: bigint,
  ): Promise<IVaultRecord> {
    const result = await this.db.select<IVaultRecord[]>(
      'INSERT INTO Vaults (id, hdPath, createdAtBlockHeight,operationalFeeMicrogons) VALUES (?, ?, ?, ?) returning *',
      toSqlParams([vaultId, hdPath, updatedAtBlockHeight, operationalFeeMicrogons]),
    );
    if (!result || result.length === 0) {
      throw new Error(`Failed to insert vault with id ${vaultId}`);
    }
    return convertFromSqliteFields<IVaultRecord[]>(result, this.fieldTypes)[0];
  }

  public async save(record: IVaultRecord): Promise<void> {
    await this.db.execute(
      'UPDATE Vaults SET operationalFeeMicrogons = ?, lastTermsUpdateHeight = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      toSqlParams([record.operationalFeeMicrogons, record.lastTermsUpdateHeight, record.id]),
    );
  }

  public async get(): Promise<IVaultRecord | undefined> {
    const rawRecords = await this.db.select<IVaultRecord[]>('SELECT * FROM Vaults LIMIT 1', []);
    return convertFromSqliteFields<IVaultRecord[]>(rawRecords, this.fieldTypes)[0];
  }

  public async deleteAll(): Promise<void> {
    await this.db.execute('DELETE FROM Vaults', []);
  }
}
