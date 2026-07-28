import { type IMiningCohortFrame, toSqliteParams } from '@argonprotocol/apps-core';
import { BaseTable } from '../db/BaseTable.ts';

export class CohortFramesTable extends BaseTable {
  public replaceForFrame(frameId: number, records: IMiningCohortFrame[]): void {
    const insert = this.db.sql.prepare(
      `INSERT INTO MiningCohortFrames (
          frameId, cohortId, blocksMinedTotal, micronotsMinedTotal,
          microgonsMinedTotal, microgonsMintedTotal, microgonFeesCollectedTotal
        ) VALUES (
          $frameId, $cohortId, $blocksMinedTotal, $micronotsMinedTotal,
          $microgonsMinedTotal, $microgonsMintedTotal, $microgonFeesCollectedTotal
        )
        ON CONFLICT(frameId, cohortId) DO UPDATE SET
          blocksMinedTotal = excluded.blocksMinedTotal,
          micronotsMinedTotal = excluded.micronotsMinedTotal,
          microgonsMinedTotal = excluded.microgonsMinedTotal,
          microgonsMintedTotal = excluded.microgonsMintedTotal,
          microgonFeesCollectedTotal = excluded.microgonFeesCollectedTotal,
          updatedAt = CURRENT_TIMESTAMP`,
    );

    this.db.sql.exec('BEGIN');
    try {
      this.db.sql.prepare('DELETE FROM MiningCohortFrames WHERE frameId = $frameId').run({ $frameId: frameId });
      for (const record of records) {
        insert.run(toSqliteParams(record));
      }
      this.db.sql.exec('COMMIT');
    } catch (error) {
      this.db.sql.exec('ROLLBACK');
      throw error;
    }
  }
}
