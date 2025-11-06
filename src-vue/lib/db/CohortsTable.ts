import { ICohortRecord } from '../../interfaces/db/ICohortRecord';
import { BaseTable } from './BaseTable';
import { convertSqliteBigInts, fromSqliteBigInt, toSqlParams } from '../Utils';
import BigNumber from 'bignumber.js';
import { bigNumberToBigInt, MiningFrames } from '@argonprotocol/apps-core';

export class CohortsTable extends BaseTable {
  private bigIntFields: string[] = [
    'transactionFeesTotal',
    'microgonsBidPerSeat',
    'micronotsStakedPerSeat',
    'microgonsToBeMinedPerSeat',
    'micronotsToBeMinedPerSeat',
  ];

  public async fetchLatestActiveId(): Promise<number | null> {
    const result = await this.db.select<{ id: number }[]>(
      'SELECT id FROM Cohorts WHERE seatCountWon > 0 ORDER BY id DESC LIMIT 1',
    );
    return result.length > 0 ? result[0].id : null;
  }

  public async fetchCohortIdsSince(id: number, limit = 10): Promise<number[]> {
    const rawRecords = await this.db.select<{ id: number }[]>(`SELECT id from Cohorts WHERE id >= ? LIMIT ?`, [
      id,
      limit + 1,
    ]);
    return rawRecords.map(record => record.id);
  }

  public async updateProgress(currentTick: number, cohortTicks: number): Promise<void> {
    // update the progress percentages of all frames by joining frames
    await this.db.execute(
      `
      UPDATE Cohorts AS c
      SET progress = COALESCE((
        SELECT ROUND(
               MIN(100.0, MAX(0.0, ((CAST(? AS REAL) - f.firstTick) * 100.0) / ?))
          )
        FROM Frames f
        WHERE f.id = c.id
      ), c.progress, 0)
      WHERE c.progress < 100
    `,
      [currentTick, cohortTicks],
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
        COALESCE(sum((transactionFeesTotal + (microgonsBidPerSeat * seatCountWon)) * (progress / 100)), 0) as framedCost
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

  public async insertOrUpdate(args: {
    id: number;
    progress: number;
    transactionFeesTotal: bigint;
    micronotsStakedPerSeat: bigint;
    microgonsBidPerSeat: bigint;
    seatCountWon: number;
    microgonsToBeMinedPerSeat: bigint;
    micronotsToBeMinedPerSeat: bigint;
  }): Promise<void> {
    const {
      id,
      progress,
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
        progress,
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
