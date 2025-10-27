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

  public async fetchById(...ids: number[]): Promise<{
    [id: number]: (ICohortRecord & { firstTick: number; lastTick: number; lastBlockNumber: number }) | null;
  }> {
    const rawRecords = await this.db.select<any[]>(
      `SELECT Cohorts.*, Frames.firstTick as firstTick, Frames.lastBlockNumber as lastBlockNumber FROM Cohorts
      LEFT JOIN Frames ON Cohorts.id = Frames.id
      WHERE Cohorts.id in (${ids.map(() => '?').join(',')})
      ORDER BY Cohorts.id DESC LIMIT 1`,
      [...ids],
    );

    const results = {} as Awaited<ReturnType<CohortsTable['fetchById']>>;
    for (const id of ids) {
      results[id] = null;
    }

    for (const rawRecord of rawRecords) {
      const record = convertSqliteBigInts<
        ICohortRecord & { firstTick: number; lastBlockNumber: number; lastTick: number }
      >(rawRecord, this.bigIntFields);
      const lastTick = record.firstTick + MiningFrames.ticksPerCohort;

      results[record.id] = {
        ...record,
        lastTick,
      };
    }
    return results;
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

  async fetchActiveSeatData(
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

    return {
      seatCountActive: rawActiveStats.seatCountTotal,
      seatCostTotalFramed: bigNumberToBigInt(seatCostTotalFramedBn),
    };
  }

  async fetchActiveCohorts(currentFrameId: number): Promise<ICohortRecord[]> {
    const records = await this.db.select<any[]>('SELECT * FROM Cohorts WHERE seatCountWon > 0 AND id >= ?', [
      currentFrameId - 9,
    ]);
    return convertSqliteBigInts(records, this.bigIntFields);
  }

  async insertOrUpdate(args: {
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

  async fetchCount(): Promise<number> {
    const [result] = await this.db.select<[{ count: number }]>('SELECT COUNT(*) as count FROM Cohorts');
    return result.count;
  }
}
