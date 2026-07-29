import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import type PluginSql from '@tauri-apps/plugin-sql';

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

export type IVaultInsert = Omit<IVaultRecord, 'createdAt' | 'updatedAt'> &
  Partial<Pick<IVaultRecord, 'createdAt' | 'updatedAt'>>;

export class VaultsTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    date: ['createdAt', 'updatedAt'],
    bigint: ['operationalFeeMicrogons'],
    boolean: ['isClosed'],
  };

  public async insert(vault: IVaultInsert, overrideSqlInstance?: PluginSql): Promise<IVaultRecord> {
    const sql = overrideSqlInstance ?? this.db;
    const createdAt = vault.createdAt ?? new Date();
    const updatedAt = vault.updatedAt ?? createdAt;
    const result = await sql.select<IVaultRecord[]>(
      `INSERT INTO Vaults (
         id, hdPath, createdAtBlockHeight, lastTermsUpdateHeight,
         operationalFeeMicrogons, isClosed, createdAt, updatedAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         hdPath = excluded.hdPath,
         createdAtBlockHeight = excluded.createdAtBlockHeight,
         operationalFeeMicrogons = excluded.operationalFeeMicrogons,
         lastTermsUpdateHeight = excluded.lastTermsUpdateHeight,
         isClosed = excluded.isClosed,
         updatedAt = excluded.updatedAt
       RETURNING *`,
      toSqlParams([
        vault.id,
        vault.hdPath,
        vault.createdAtBlockHeight,
        vault.lastTermsUpdateHeight,
        vault.operationalFeeMicrogons,
        vault.isClosed,
        createdAt,
        updatedAt,
      ]),
    );
    if (!result || result.length === 0) {
      throw new Error(`Failed to insert vault with id ${vault.id}`);
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
