import { ICohortFrameRecord } from '../../interfaces/db/ICohortFrameRecord';
import { BaseTable } from './BaseTable';
import { toSqliteBigInt } from '../Utils';
import { LRU } from 'tiny-lru';

export class CohortFramesTable extends BaseTable {
  private cache = new LRU<Partial<ICohortFrameRecord>>(25);
  public async insertOrUpdate(args: {
    frameId: number;
    cohortActivationFrameId: number;
    blocksMinedTotal: number;
    micronotsMinedTotal: bigint;
    microgonsMinedTotal: bigint;
    microgonsMintedTotal: bigint;
    microgonFeesCollectedTotal: bigint;
  }): Promise<void> {
    const {
      frameId,
      cohortActivationFrameId,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,
    } = args;
    const cache = this.cache.get(frameId);
    if (cache) {
      // If nothing has changed, skip the database write
      if (
        cache.blocksMinedTotal === blocksMinedTotal &&
        cache.micronotsMinedTotal === micronotsMinedTotal &&
        cache.microgonsMinedTotal === microgonsMinedTotal &&
        cache.microgonsMintedTotal === microgonsMintedTotal &&
        cache.microgonFeesCollectedTotal === microgonFeesCollectedTotal
      ) {
        return;
      }
    }
    this.cache.set(frameId, {
      frameId,
      cohortId: cohortActivationFrameId,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,
    });
    await this.db.execute(
      `INSERT INTO CohortFrames (
          frameId, cohortId, blocksMinedTotal, micronotsMinedTotal, microgonsMinedTotal, microgonsMintedTotal, microgonFeesCollectedTotal
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(frameId, cohortId) DO UPDATE SET 
          blocksMinedTotal = excluded.blocksMinedTotal, 
          micronotsMinedTotal = excluded.micronotsMinedTotal, 
          microgonsMinedTotal = excluded.microgonsMinedTotal, 
          microgonsMintedTotal = excluded.microgonsMintedTotal,
          microgonFeesCollectedTotal = excluded.microgonFeesCollectedTotal
      `,
      [
        frameId,
        cohortActivationFrameId,
        blocksMinedTotal,
        toSqliteBigInt(micronotsMinedTotal),
        toSqliteBigInt(microgonsMinedTotal),
        toSqliteBigInt(microgonsMintedTotal),
        toSqliteBigInt(microgonFeesCollectedTotal),
      ],
    );
  }
}
