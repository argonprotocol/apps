import { IServerStateRecord } from '../../interfaces/db/IServerStateRecord.ts';
import { BaseTable, IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { type IBlockToProcess } from '../WalletBalances.ts';

export enum SyncStateKeys {
  Server = 'Server',
  Wallet = 'Wallet',
}

export interface ISyncSchemas {
  [SyncStateKeys.Server]: IServerStateRecord;
  [SyncStateKeys.Wallet]: IBlockToProcess;
}

export class SyncStateTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    json: ['state'],
    date: ['createdAt', 'updatedAt'],
  };

  public override async loadState(): Promise<void> {
    try {
      const record = await this.db.select<IServerStateRecord[]>(`SELECT * FROM ServerState LIMIT 1`, []);
      if (record.length > 0) {
        const serverState = convertFromSqliteFields<IServerStateRecord>(record[0], {
          json: [],
          date: [
            'createdAt',
            'insertedAt',
            'updatedAt',
            'botActivityLastUpdatedAt',
            'argonBlocksLastUpdatedAt',
            'bitcoinBlocksLastUpdatedAt',
          ],
        });
        await this.upsert(SyncStateKeys.Server, serverState);
        await this.db.execute(`DELETE FROM ServerState`, []);
      }
    } catch (err) {
      // Table might not exist yet
    }
  }

  public async upsert<KEY extends SyncStateKeys>(key: KEY, state: ISyncSchemas[KEY]): Promise<void> {
    await this.db.execute(
      `INSERT INTO SyncState (key, state) 
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET 
          state = ?2,
          updatedAt = CURRENT_TIMESTAMP`,
      toSqlParams([key, state]),
    );
  }

  public async get<KEY extends SyncStateKeys>(key: KEY): Promise<ISyncSchemas[KEY] | null> {
    const rawRecords = await this.db.select('SELECT state FROM SyncState WHERE key=? LIMIT 1', [key]);
    return convertFromSqliteFields<{ state: ISyncSchemas[KEY] }[]>(rawRecords, this.fieldTypes)[0]?.state ?? null;
  }
}
