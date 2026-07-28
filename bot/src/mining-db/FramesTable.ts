import type { SQLOutputValue } from 'node:sqlite';
import { convertFromSqliteFields, type IMiningFrame, toSqliteParams } from '@argonprotocol/apps-core';
import { BaseTable } from '../db/BaseTable.ts';

type SqlFrameRow = Record<string, SQLOutputValue>;

const fieldTypes = {
  boolean: ['isProcessed'],
  bigintJson: ['microgonToUsd', 'microgonToBtc', 'microgonToArgonot'],
  bigint: [
    'seatCostTotalFramed',
    'microgonsMinedTotal',
    'microgonsMintedTotal',
    'micronotsMinedTotal',
    'microgonFeesCollectedTotal',
    'accruedMicrogonProfits',
    'accruedMicronotProfits',
  ],
};

export class FramesTable extends BaseTable {
  public insertOrUpdate(
    frame: Pick<
      IMiningFrame,
      | 'id'
      | 'firstTick'
      | 'rewardTicksRemaining'
      | 'firstBlockNumber'
      | 'lastBlockNumber'
      | 'microgonToUsd'
      | 'microgonToBtc'
      | 'microgonToArgonot'
      | 'accruedMicrogonProfits'
      | 'accruedMicronotProfits'
      | 'progress'
    >,
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO MiningFrames (
          id, firstTick, rewardTicksRemaining, firstBlockNumber, lastBlockNumber,
          microgonToUsd, microgonToBtc, microgonToArgonot,
          accruedMicrogonProfits, accruedMicronotProfits, progress
        ) VALUES (
          $id, $firstTick, $rewardTicksRemaining, $firstBlockNumber, $lastBlockNumber,
          $microgonToUsd, $microgonToBtc, $microgonToArgonot,
          $accruedMicrogonProfits, $accruedMicronotProfits, $progress
        )
        ON CONFLICT(id) DO UPDATE SET
          firstTick = excluded.firstTick,
          rewardTicksRemaining = excluded.rewardTicksRemaining,
          firstBlockNumber = excluded.firstBlockNumber,
          lastBlockNumber = excluded.lastBlockNumber,
          microgonToUsd = excluded.microgonToUsd,
          microgonToBtc = excluded.microgonToBtc,
          microgonToArgonot = excluded.microgonToArgonot,
          accruedMicrogonProfits = excluded.accruedMicrogonProfits,
          accruedMicronotProfits = excluded.accruedMicronotProfits,
          progress = excluded.progress,
          isProcessed = 0,
          updatedAt = CURRENT_TIMESTAMP`,
      )
      .run(toSqliteParams(frame));
  }

  public updateRollup(
    frame: Pick<
      IMiningFrame,
      | 'id'
      | 'allMinersCount'
      | 'seatCountActive'
      | 'seatCostTotalFramed'
      | 'blocksMinedTotal'
      | 'micronotsMinedTotal'
      | 'microgonsMinedTotal'
      | 'microgonsMintedTotal'
      | 'microgonFeesCollectedTotal'
      | 'isProcessed'
    >,
  ): void {
    this.db.sql
      .prepare(
        `UPDATE MiningFrames SET
          allMinersCount = $allMinersCount,
          seatCountActive = $seatCountActive,
          seatCostTotalFramed = $seatCostTotalFramed,
          blocksMinedTotal = $blocksMinedTotal,
          micronotsMinedTotal = $micronotsMinedTotal,
          microgonsMinedTotal = $microgonsMinedTotal,
          microgonsMintedTotal = $microgonsMintedTotal,
          microgonFeesCollectedTotal = $microgonFeesCollectedTotal,
          isProcessed = $isProcessed,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id`,
      )
      .run(toSqliteParams({ ...frame, isProcessed: frame.isProcessed ? 1 : 0 }));
  }

  public fetchLast(limit = 365): IMiningFrame[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM MiningFrames ORDER BY id DESC LIMIT $limit')
      .all({ $limit: limit }) as SqlFrameRow[];
    return convertFromSqliteFields<IMiningFrame[]>(rows, fieldTypes).reverse();
  }

  public fetchLastProcessedFrame(): number | undefined {
    const row = this.db.sql.prepare('SELECT MAX(id) AS id FROM MiningFrames WHERE isProcessed = 1').get() as {
      id: number | null;
    };
    return row.id ?? undefined;
  }

  public fetchArgonotPricesAroundFrame(frameId: number): Pick<IMiningFrame, 'id' | 'microgonToArgonot'>[] {
    const priceFilter = `json_array_length(microgonToArgonot) > 0
      AND CAST(RTRIM(json_extract(
        microgonToArgonot,
        '$[' || (json_array_length(microgonToArgonot) - 1) || ']'
      ), 'n') AS INTEGER) > 0`;
    const before = this.db.sql
      .prepare(
        `SELECT id, microgonToArgonot
        FROM MiningFrames
        WHERE id < $frameId AND ${priceFilter}
        ORDER BY id DESC
        LIMIT 1`,
      )
      .get({ $frameId: frameId }) as SqlFrameRow | undefined;
    const after = this.db.sql
      .prepare(
        `SELECT id, microgonToArgonot
        FROM MiningFrames
        WHERE id >= $frameId AND ${priceFilter}
        ORDER BY id ASC
        LIMIT 1`,
      )
      .get({ $frameId: frameId }) as SqlFrameRow | undefined;
    const rows = [before, after].filter((x): x is SqlFrameRow => Boolean(x));
    return convertFromSqliteFields<Pick<IMiningFrame, 'id' | 'microgonToArgonot'>[]>(rows, fieldTypes);
  }
}
