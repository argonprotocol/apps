import { Db } from '../Db';
import { IServerStateRecord } from '../../interfaces/db/IServerStateRecord.ts';
import { IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export class ServerStateTable {
  private db: Db;
  private fieldTypes: IFieldTypes = {
    json: ['botActivities'],
    date: [
      'createdAt',
      'insertedAt',
      'updatedAt',
      'botActivityLastUpdatedAt',
      'argonBlocksLastUpdatedAt',
      'bitcoinBlocksLastUpdatedAt',
    ],
  };

  constructor(db: Db) {
    this.db = db;
  }

  public async insertOrUpdateBlocks(
    args: Omit<IServerStateRecord, 'id' | 'insertedAt' | 'createdAt'>,
  ): Promise<IServerStateRecord> {
    const {
      latestFrameId,
      argonLocalNodeBlockNumber,
      argonMainNodeBlockNumber,
      argonBlocksLastUpdatedAt,
      bitcoinLocalNodeBlockNumber,
      bitcoinMainNodeBlockNumber,
      bitcoinBlocksLastUpdatedAt,
      botActivities,
      botActivityLastUpdatedAt,
      botActivityLastBlockNumber,
    } = args;
    const [rawRecord] = await this.db.select<IServerStateRecord[]>(
      `INSERT INTO ServerState 
            (id, latestFrameId, 
             argonLocalNodeBlockNumber, argonMainNodeBlockNumber, argonBlocksLastUpdatedAt, 
             bitcoinLocalNodeBlockNumber, bitcoinMainNodeBlockNumber, bitcoinBlocksLastUpdatedAt,
             botActivities, botActivityLastUpdatedAt, botActivityLastBlockNumber) 
        VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET 
          latestFrameId = ?1,
          argonLocalNodeBlockNumber = ?2,
          argonMainNodeBlockNumber = ?3, 
          argonBlocksLastUpdatedAt = ?4,
          bitcoinLocalNodeBlockNumber = ?5, 
          bitcoinMainNodeBlockNumber = ?6,
          bitcoinBlocksLastUpdatedAt = ?7,
          botActivities = ?8,
          botActivityLastUpdatedAt = ?9,
          botActivityLastBlockNumber = ?10,
          updatedAt = CURRENT_TIMESTAMP
         RETURNING *`,
      toSqlParams([
        latestFrameId,
        argonLocalNodeBlockNumber,
        argonMainNodeBlockNumber,
        argonBlocksLastUpdatedAt,
        bitcoinLocalNodeBlockNumber,
        bitcoinMainNodeBlockNumber,
        bitcoinBlocksLastUpdatedAt,
        botActivities,
        botActivityLastUpdatedAt,
        botActivityLastBlockNumber,
      ]),
    );
    return rawRecord;
  }

  public async get(): Promise<IServerStateRecord | null> {
    const rawRecords = await this.db.select<IServerStateRecord[]>('SELECT * FROM ServerState LIMIT 1', []);
    return convertFromSqliteFields<IServerStateRecord[]>(rawRecords, this.fieldTypes)[0];
  }
}
