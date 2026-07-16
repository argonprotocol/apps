import { ICohortRecord } from '../../interfaces/db/ICohortRecord';
import { BaseTable } from './BaseTable';
import { convertSqliteBigInts, fromSqliteBigInt, toSqlParams } from '../Utils';
import BigNumber from 'bignumber.js';
import { bigNumberToBigInt, NetworkConfig } from '@argonprotocol/apps-core';
import type { IMiningCohortFinancialRecord } from '../../interfaces/db/ICohortFrameRecord.ts';

export class CohortsTable extends BaseTable {
  private storedCohorts: { [id: number]: boolean } = {};
  private bigIntFields: string[] = [
    'transactionFeesTotal',
    'microgonsBidPerSeat',
    'micronotsStakedPerSeat',
    'microgonsToBeMinedPerSeat',
    'micronotsToBeMinedPerSeat',
    'argonotPriceAtBid',
    'closingArgonotPrice',
  ];

  public override async loadState(): Promise<void> {
    const allCohorts = await this.db.select<{ id: number }[]>('SELECT id FROM Cohorts ORDER BY id ASC');
    for (const cohort of allCohorts) {
      this.storedCohorts[cohort.id] = true;
    }
  }

  public async getTxFees(cohortId: number): Promise<bigint> {
    const [result] = await this.db.select<[{ transactionFeesTotal: bigint }]>(
      'SELECT transactionFeesTotal FROM Cohorts WHERE id = ?',
      [cohortId],
    );
    return result ? fromSqliteBigInt(result.transactionFeesTotal as any) : 0n;
  }

  public async fetchCohortIdsSince(idStart: number, limit = 10): Promise<number[]> {
    const ids = [];
    for (let id = idStart; id < idStart + limit; id++) {
      if (!this.storedCohorts[id]) break;
      ids.push(id);
    }
    return ids;
  }

  public async updateProgress(): Promise<void> {
    // update the progress percentages of all frames by joining frames
    const framesPerCohort = NetworkConfig.framesPerCohort;
    await this.db.execute(
      `
        UPDATE Cohorts AS c
        SET progress = (
          SELECT SUM(f.progress) / ?
          FROM Frames f
          WHERE f.id >= c.id
            AND f.id < c.id + ?
        )
        WHERE c.progress < 100
      `,
      [framesPerCohort, framesPerCohort],
    );
  }

  public async setArgonotPriceAtCompletion(cohortId: number, argonotPrice: bigint): Promise<void> {
    if (argonotPrice <= 0n) return;

    await this.db.execute(
      `UPDATE Cohorts
       SET closingArgonotPrice = ?
       WHERE id = ? AND closingArgonotPrice = '0'`,
      toSqlParams([argonotPrice, cohortId]),
    );
  }

  public async fetchGlobalStats(): Promise<{
    seatsTotal: number;
    framesCompleted: number;
    framesRemaining: number;
    framedCost: bigint;
    transactionFeesTotal: bigint;
    microgonsBidTotal: bigint;
    micronotsMinedTotal: bigint;
    microgonsMinedTotal: bigint;
    microgonsMintedTotal: bigint;
  }> {
    try {
      const [stats] = await this.db.select<[any]>(
        `WITH cohortStats AS (
          SELECT
            COALESCE(SUM(transactionFeesTotal), 0) AS transactionFeesTotal,
            COALESCE(SUM(microgonsBidPerSeat * seatCountWon), 0) AS microgonsBidTotal,
            COALESCE(SUM((transactionFeesTotal + (microgonsBidPerSeat * seatCountWon)) * (progress / 100.0)), 0) AS framedCost,
            COALESCE(SUM(CASE WHEN seatCountWon > 0 THEN progress * seatCountWon ELSE 0 END), 0.0) AS accruedProgress,
            COALESCE(SUM(CASE WHEN seatCountWon > 0 THEN seatCountWon ELSE 0 END), 0) AS seatCountTotal
          FROM Cohorts
        ), cohortFrameStats AS (
          SELECT
            COALESCE(SUM(micronotsMinedTotal), 0) AS micronotsMinedTotal,
            COALESCE(SUM(microgonsMinedTotal), 0) AS microgonsMinedTotal,
            COALESCE(SUM(microgonsMintedTotal), 0) AS microgonsMintedTotal
          FROM CohortFrames
        )
        SELECT * FROM cohortStats CROSS JOIN cohortFrameStats`,
      );

      const framesExpectedBn = BigNumber(stats.seatCountTotal).multipliedBy(NetworkConfig.framesPerCohort);
      const framesCompleted = BigNumber(stats.accruedProgress).dividedBy(NetworkConfig.framesPerCohort).toNumber();
      const framesRemaining = framesExpectedBn.minus(framesCompleted).toNumber();

      return {
        seatsTotal: stats.seatCountTotal,
        framesCompleted,
        framesRemaining,
        framedCost: fromSqliteBigInt(stats.framedCost),
        transactionFeesTotal: fromSqliteBigInt(stats.transactionFeesTotal),
        microgonsBidTotal: fromSqliteBigInt(stats.microgonsBidTotal),
        micronotsMinedTotal: fromSqliteBigInt(stats.micronotsMinedTotal),
        microgonsMinedTotal: fromSqliteBigInt(stats.microgonsMinedTotal),
        microgonsMintedTotal: fromSqliteBigInt(stats.microgonsMintedTotal),
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
    const framesPerCohort = NetworkConfig.framesPerCohort;
    const [rawActiveStats] = await this.db.select<[any]>(
      `SELECT 
        COALESCE(sum(seatCountWon), 0) as seatCountTotal,
        COALESCE(sum(microgonsBidPerSeat * seatCountWon), 0) as seatCostTotal
      FROM Cohorts WHERE id <= ? AND id >= ?`,
      [frameId, frameId - framesPerCohort + 1],
    );

    const frameProgressBn = BigNumber(frameProgress).dividedBy(100);
    const seatCostTotalPerDayBn = BigNumber(fromSqliteBigInt(rawActiveStats.seatCostTotal)).dividedBy(framesPerCohort);
    const seatCostTotalFramedBn = BigNumber(seatCostTotalPerDayBn).multipliedBy(frameProgressBn);
    // TODO: add micronot depreciation to cost (see Bidding Calculator)

    return {
      seatCountActive: rawActiveStats.seatCountTotal,
      seatCostTotalFramed: bigNumberToBigInt(seatCostTotalFramedBn),
    };
  }

  public async fetchFinancialPositions(fromFrameId = 0): Promise<IMiningCohortFinancialRecord[]> {
    const records = await this.db.select<IMiningCohortFinancialRecord[]>(
      `SELECT
        c.*,
        COALESCE(SUM(cf.micronotsMinedTotal), 0) AS micronotsMinedTotal,
        COALESCE(SUM(cf.microgonsMinedTotal), 0) AS microgonsMinedTotal,
        COALESCE(SUM(cf.microgonsMintedTotal), 0) AS microgonsMintedTotal,
        COALESCE(SUM(cf.microgonFeesCollectedTotal), 0) AS microgonFeesCollectedTotal
      FROM Cohorts c
      LEFT JOIN CohortFrames cf ON cf.cohortId = c.id
      WHERE c.seatCountWon > 0 AND c.id >= ?
      GROUP BY c.id
      ORDER BY c.id ASC`,
      [fromFrameId],
    );
    return convertSqliteBigInts(records, [
      ...this.bigIntFields,
      'micronotsMinedTotal',
      'microgonsMinedTotal',
      'microgonsMintedTotal',
      'microgonFeesCollectedTotal',
    ]);
  }

  public async fetchByIds(ids: number[]): Promise<ICohortRecord[]> {
    if (!ids.length) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    const records = await this.db.select<any[]>(`SELECT * FROM Cohorts WHERE id IN (${placeholders})`, ids);
    return convertSqliteBigInts(records, this.bigIntFields);
  }

  public async insertOrUpdate(args: {
    id: number;
    transactionFeesTotal: bigint;
    micronotsStakedPerSeat: bigint;
    microgonsBidPerSeat: bigint;
    seatCountWon: number;
    microgonsToBeMinedPerSeat: bigint;
    micronotsToBeMinedPerSeat: bigint;
    argonotPriceAtBid: bigint;
  }): Promise<void> {
    const {
      id,
      transactionFeesTotal,
      micronotsStakedPerSeat,
      microgonsBidPerSeat,
      seatCountWon,
      microgonsToBeMinedPerSeat,
      micronotsToBeMinedPerSeat,
      argonotPriceAtBid,
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
          micronotsToBeMinedPerSeat,
          argonotPriceAtBid
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(id) DO UPDATE SET 
          progress = excluded.progress, 
          transactionFeesTotal = excluded.transactionFeesTotal, 
          micronotsStakedPerSeat = excluded.micronotsStakedPerSeat, 
          microgonsBidPerSeat = excluded.microgonsBidPerSeat, 
          seatCountWon = excluded.seatCountWon, 
          microgonsToBeMinedPerSeat = excluded.microgonsToBeMinedPerSeat, 
          micronotsToBeMinedPerSeat = excluded.micronotsToBeMinedPerSeat,
          argonotPriceAtBid = excluded.argonotPriceAtBid
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
        argonotPriceAtBid,
      ]),
    );
    this.storedCohorts[id] = true;
  }

  public async fetchCount(): Promise<number> {
    const [result] = await this.db.select<[{ count: number }]>('SELECT COUNT(*) as count FROM Cohorts');
    return result.count;
  }
}
