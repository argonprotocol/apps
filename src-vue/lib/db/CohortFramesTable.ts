import { ICohortFrameRecord, ICohortFrameStats } from '../../interfaces/db/ICohortFrameRecord';
import { BaseTable } from './BaseTable';
import { convertSqliteBigInts, fromSqliteBigInt, toSqliteBigInt } from '../Utils';
import { LRU } from 'tiny-lru';

export class CohortFramesTable extends BaseTable {
  private cache = new LRU<Partial<ICohortFrameRecord>>(25);
  private bigIntFields: string[] = [
    'micronotsMinedTotal',
    'microgonsMinedTotal',
    'microgonsMintedTotal',
    'microgonFeesCollectedTotal',
  ];

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

  public async fetchActiveCohortFrames(currentFrameId: number): Promise<ICohortFrameRecord[]> {
    const records = await this.db.select<ICohortFrameRecord[]>('SELECT * FROM CohortFrames WHERE frameId > ?', [
      currentFrameId - 10,
    ]);
    return convertSqliteBigInts(records, this.bigIntFields);
  }

  public async fetchGlobalStats(): Promise<Omit<ICohortFrameStats, 'blocksMinedTotal'>> {
    const [rawResults] = await this.db.select<[any]>(
      `SELECT 
        COALESCE(sum(micronotsMinedTotal), 0) as micronotsMinedTotal,
        COALESCE(sum(microgonsMinedTotal), 0) as microgonsMinedTotal,
        COALESCE(sum(microgonsMintedTotal), 0) as microgonsMintedTotal
      FROM CohortFrames`,
    );

    const results = rawResults;
    return {
      micronotsMinedTotal: fromSqliteBigInt(results.micronotsMinedTotal),
      microgonsMinedTotal: fromSqliteBigInt(results.microgonsMinedTotal),
      microgonsMintedTotal: fromSqliteBigInt(results.microgonsMintedTotal),
    };
  }
}
