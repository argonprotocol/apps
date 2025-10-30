import { ICohortFrameRecord, ICohortFrameStats } from '../../interfaces/db/ICohortFrameRecord';
import { BaseTable } from './BaseTable';
import { convertSqliteBigInts, fromSqliteBigInt, toSqliteBigInt } from '../Utils';

export class CohortFramesTable extends BaseTable {
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
    const records = await this.db.select<ICohortFrameRecord[]>('SELECT * FROM CohortFrames WHERE frameId >= ?', [
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
