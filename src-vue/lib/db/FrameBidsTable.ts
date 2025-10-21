import { IFrameBidRecord } from '../../interfaces/db/IFrameBidRecord';
import { BaseTable } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';

export class FrameBidsTable extends BaseTable {
  private jsonFields: string[] = ['bidsJson'];

  async insertOrUpdate(frameId: number, confirmedAtBlockNumber: number, bids: IBidEntry[]): Promise<void> {
    await this.db.execute(
      `INSERT INTO FrameBids (
          frameId, confirmedAtBlockNumber, bidsJson
        ) VALUES (
          ?, ?, ?
        ) ON CONFLICT(frameId) DO UPDATE SET 
          confirmedAtBlockNumber = excluded.confirmedAtBlockNumber, 
          bidsJson = excluded.bidsJson
      `,
      toSqlParams([frameId, confirmedAtBlockNumber, bids]),
    );
  }

  async fetchForFrameId(frameId: number): Promise<IFrameBidRecord[]> {
    const rawRecords = await this.db.select<IFrameBidRecord[]>('SELECT * FROM FrameBids WHERE frameId = ? LIMIT 1', [
      frameId,
    ]);
    const frameBids = convertFromSqliteFields<
      {
        frameId: number;
        confirmedAtBlockNumber: number;
        bidsJson: IBidEntry[];
        createdAt: string;
        updatedAt: string;
      }[]
    >(rawRecords, { json: this.jsonFields })[0];
    if (!frameBids) return [];

    const records: IFrameBidRecord[] = [];
    for (const record of frameBids.bidsJson) {
      records.push({
        frameId: frameId,
        confirmedAtBlockNumber: frameBids.confirmedAtBlockNumber,
        address: record.address,
        subAccountIndex: record.subAccountIndex,
        microgonsPerSeat: record.microgonsPerSeat,
        micronotsStakedPerSeat: record.micronotsStakedPerSeat ?? 0n,
        bidPosition: record.bidPosition,
        lastBidAtTick: record.lastBidAtTick,
        createdAt: frameBids.createdAt,
        updatedAt: frameBids.updatedAt,
      });
    }
    return records;
  }
}

export interface IBidEntry {
  address: string;
  subAccountIndex: number | undefined;
  microgonsPerSeat: bigint;
  micronotsStakedPerSeat: bigint | undefined;
  bidPosition: number;
  lastBidAtTick: number | undefined;
}
