import { ICohortRecord } from '../../interfaces/db/ICohortRecord';
import { BaseTable } from './BaseTable';
import { convertSqliteBigInts, fromSqliteBigInt, toSqlParams } from '../Utils';
import BigNumber from 'bignumber.js';
import { bigNumberToBigInt } from '@argonprotocol/apps-core';

export class CohortsTable extends BaseTable {
  private storedCohorts: { [id: number]: boolean } = {};
  private bigIntFields: string[] = [
    'transactionFeesTotal',
    'microgonsBidPerSeat',
    'micronotsStakedPerSeat',
    'microgonsToBeMinedPerSeat',
    'micronotsToBeMinedPerSeat',
  ];

  public override async loadState(): Promise<void> {
    const allCohorts = await this.db.select<{ id: number }[]>(`SELECT id from Cohorts ORDER BY id ASC`);
    for (const cohort of allCohorts) {
      this.storedCohorts[cohort.id] = true;
    }
  }

  public async fetchCohortIdsSince(idStart: number, limit = 10): Promise<number[]> {
    const ids = [];
    for (let id = idStart; id < idStart + limit; id++) {
      if (!this.storedCohorts[id]) {
        break;
      }
      ids.push(id);
    }
    return ids;
  }

  public async updateProgress(): Promise<void> {
    // update the progress percentages of all frames by joining frames
    await this.db.execute(
      `
        UPDATE Cohorts AS c
        SET progress = (
          SELECT SUM(f.progress) / 10.0
          FROM Frames f
          WHERE f.id >= c.id
            AND f.id < c.id + 10
        )
        WHERE c.progress < 100
    `,
    );
  }

  public async fetchGlobalStats(): Promise<{
    seatsTotal: number;
    framesCompleted: number;
    framesRemaining: number;
    framedCost: bigint;
    transactionFeesTotal: bigint;
    microgonsBidTotal: bigint;
  }> {
    try {
      const [allStats] = await this.db.select<[any]>(
        `SELECT 
        COALESCE(sum(transactionFeesTotal), 0) as transactionFeesTotal, 
        COALESCE(sum(microgonsBidPerSeat), 0) as microgonsBidTotal,
        COALESCE(sum((transactionFeesTotal + (microgonsBidPerSeat * seatCountWon)) * (progress / 100.0)), 0) as framedCost
      FROM Cohorts`,
      );

      // const oldestActiveFrameId = Math.max(1, currentFrameId - 10);
      const [activeStats] = await this.db.select<[any]>(
        `SELECT 
        count(*) as cohortCount,
        COALESCE(sum(progress * seatCountWon), 0.0) as accruedProgress,
        COALESCE(sum(seatCountWon), 0) as seatCountTotal
      FROM Cohorts WHERE seatCountWon > 0`,
        [],
      );

      const framesExpectedBn = BigNumber(activeStats.seatCountTotal).multipliedBy(10);
      const framesCompleted = BigNumber(activeStats.accruedProgress).dividedBy(10).toNumber();
      const framesRemaining = framesExpectedBn.minus(framesCompleted).toNumber();

      return {
        seatsTotal: activeStats.seatCountTotal,
        framesCompleted,
        framesRemaining,
        framedCost: fromSqliteBigInt(allStats.framedCost),
        transactionFeesTotal: fromSqliteBigInt(allStats.transactionFeesTotal),
        microgonsBidTotal: fromSqliteBigInt(allStats.microgonsBidTotal),
      };
    } catch (e) {
      console.error('Error fetching global stats', e);
      throw e;
    }
  }

  public async fetchActiveSeatData(
    frameId: number,
    frameProgress: number,
  ): Promise<{ seatCountActive: number; seatCostTotalFramed: bigint }> {
    const [rawActiveStats] = await this.db.select<[any]>(
      `SELECT 
        COALESCE(sum(seatCountWon), 0) as seatCountTotal,
        COALESCE(sum(microgonsBidPerSeat * seatCountWon), 0) as seatCostTotal
      FROM Cohorts WHERE id <= ? AND id >= ?`,
      [frameId, frameId - 9],
    );

    const frameProgressBn = BigNumber(frameProgress).dividedBy(100);
    const seatCostTotalPerDayBn = BigNumber(fromSqliteBigInt(rawActiveStats.seatCostTotal)).dividedBy(10);
    const seatCostTotalFramedBn = BigNumber(seatCostTotalPerDayBn).multipliedBy(frameProgressBn);
    // TODO: add micronot depreciation to cost (see Bidding Calculator)

    return {
      seatCountActive: rawActiveStats.seatCountTotal,
      seatCostTotalFramed: bigNumberToBigInt(seatCostTotalFramedBn),
    };
  }

  public async fetchActiveCohorts(currentFrameId: number): Promise<ICohortRecord[]> {
    const records = await this.db.select<any[]>('SELECT * FROM Cohorts WHERE seatCountWon > 0 AND id >= ?', [
      currentFrameId - 9,
    ]);
    return convertSqliteBigInts(records, this.bigIntFields);
  }

  public async fetchNetMiningResults(): Promise<{
    cohortId: number;
    totalCost: number;
    minedMicrogons: bigint;
    minedMicronots: bigint;
  }> {
    const [{ totalCost, cohortId, minedMicrogons, minedMicronots }] = await this.db.select<
      [{ cohortId: number; totalCost: number; minedMicrogons: bigint; minedMicronots: bigint }]
    >(
      `SELECT
         c.id as cohortId,
         (c.microgonsBidPerSeat * c.seatCountWon) + c.transactionFeesTotal as totalCost,
         SUM(microgonsMinedTotal + microgonsMintedTotal) as minedMicrogons,
         SUM(micronotsMinedTotal) as minedMicronots
       FROM Cohorts c JOIN CohortFrames cf ON c.id = cf.cohortId
       WHERE c.progress = 100 AND c.seatCountWon > 0
       GROUP BY cf.cohortId`,
    );
    return {
      cohortId,
      totalCost,
      minedMicronots,
      minedMicrogons,
    };
  }

  public async insertOrUpdate(args: {
    id: number;
    transactionFeesTotal: bigint;
    micronotsStakedPerSeat: bigint;
    microgonsBidPerSeat: bigint;
    seatCountWon: number;
    microgonsToBeMinedPerSeat: bigint;
    micronotsToBeMinedPerSeat: bigint;
  }): Promise<void> {
    this.storedCohorts[args.id] = true;
    const {
      id,
      transactionFeesTotal,
      micronotsStakedPerSeat,
      microgonsBidPerSeat,
      seatCountWon,
      microgonsToBeMinedPerSeat,
      micronotsToBeMinedPerSeat,
    } = args;
    await this.db.execute(
      `INSERT INTO Cohorts (
          id, 
          progress, 
          transactionFeesTotal, 
          micronotsStakedPerSeat,
          microgonsBidPerSeat,
          seatCountWon,
          microgonsToBeMinedPerSeat,
          micronotsToBeMinedPerSeat
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(id) DO UPDATE SET 
          progress = excluded.progress, 
          transactionFeesTotal = excluded.transactionFeesTotal, 
          micronotsStakedPerSeat = excluded.micronotsStakedPerSeat, 
          microgonsBidPerSeat = excluded.microgonsBidPerSeat, 
          seatCountWon = excluded.seatCountWon, 
          microgonsToBeMinedPerSeat = excluded.microgonsToBeMinedPerSeat, 
          micronotsToBeMinedPerSeat = excluded.micronotsToBeMinedPerSeat
      `,
      toSqlParams([
        id,
        0,
        transactionFeesTotal,
        micronotsStakedPerSeat,
        microgonsBidPerSeat,
        seatCountWon,
        microgonsToBeMinedPerSeat,
        micronotsToBeMinedPerSeat,
      ]),
    );
  }

  public async fetchCount(): Promise<number> {
    const [result] = await this.db.select<[{ count: number }]>('SELECT COUNT(*) as count FROM Cohorts');
    return result.count;
  }
}
