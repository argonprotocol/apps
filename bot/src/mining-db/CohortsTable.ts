import type { SQLOutputValue } from 'node:sqlite';
import BigNumber from 'bignumber.js';
import {
  bigNumberToBigInt,
  convertFromSqliteFields,
  type IMiningCohort,
  type IMiningCohortFrame,
  type IMiningCohortFinancial,
  type IMiningSummary,
  NetworkConfig,
  toSqliteParams,
} from '@argonprotocol/apps-core';
import { BaseTable } from '../db/BaseTable.ts';

type SqlCohortRow = Record<string, SQLOutputValue>;
type SqlCohortFrameRow = Record<string, SQLOutputValue> & { cohortId: number };

const bigintFields = [
  'transactionFeesTotal',
  'microgonsBidPerSeat',
  'micronotsStakedPerSeat',
  'microgonsToBeMinedPerSeat',
  'micronotsToBeMinedPerSeat',
  'argonotPriceAtBid',
  'closingArgonotPrice',
  'micronotsMinedTotal',
  'microgonsMinedTotal',
  'microgonsMintedTotal',
  'microgonFeesCollectedTotal',
];

export class CohortsTable extends BaseTable {
  public insertOrUpdate(cohort: Omit<IMiningCohort, 'progress' | 'closingArgonotPrice'>): void {
    this.db.sql
      .prepare(
        `INSERT INTO MiningCohorts (
          id, transactionFeesTotal, micronotsStakedPerSeat, microgonsBidPerSeat,
          seatCountWon, microgonsToBeMinedPerSeat, micronotsToBeMinedPerSeat, argonotPriceAtBid
        ) VALUES (
          $id, $transactionFeesTotal, $micronotsStakedPerSeat, $microgonsBidPerSeat,
          $seatCountWon, $microgonsToBeMinedPerSeat, $micronotsToBeMinedPerSeat, $argonotPriceAtBid
        )
        ON CONFLICT(id) DO UPDATE SET
          transactionFeesTotal = excluded.transactionFeesTotal,
          micronotsStakedPerSeat = excluded.micronotsStakedPerSeat,
          microgonsBidPerSeat = excluded.microgonsBidPerSeat,
          seatCountWon = excluded.seatCountWon,
          microgonsToBeMinedPerSeat = excluded.microgonsToBeMinedPerSeat,
          micronotsToBeMinedPerSeat = excluded.micronotsToBeMinedPerSeat,
          argonotPriceAtBid = excluded.argonotPriceAtBid,
          updatedAt = CURRENT_TIMESTAMP`,
      )
      .run(toSqliteParams(cohort));
  }

  public fetchIds(): number[] {
    return (this.db.sql.prepare('SELECT id FROM MiningCohorts').all() as { id: number }[]).map(x => x.id);
  }

  public updateProgress(): void {
    this.db.sql
      .prepare(
        `UPDATE MiningCohorts AS c
        SET progress = (
          SELECT COALESCE(SUM(f.progress), 0) / $framesPerCohort
          FROM MiningFrames f
          WHERE f.id >= c.id
            AND f.id < c.id + $framesPerCohort
        )
        WHERE c.progress < 100`,
      )
      .run({ $framesPerCohort: NetworkConfig.framesPerCohort });
  }

  public setClosingArgonotPrice(cohortId: number, price: bigint): void {
    if (price <= 0n) return;
    this.db.sql
      .prepare(
        `UPDATE MiningCohorts
        SET closingArgonotPrice = $price, updatedAt = CURRENT_TIMESTAMP
        WHERE id = $cohortId`,
      )
      .run(toSqliteParams({ cohortId, price }));
  }

  public fetchCohortIdsMissingBidPrice(): number[] {
    return (
      this.db.sql.prepare("SELECT id FROM MiningCohorts WHERE argonotPriceAtBid = '0' ORDER BY id ASC").all() as {
        id: number;
      }[]
    ).map(x => x.id);
  }

  public setArgonotPriceAtBid(cohortId: number, price: bigint): void {
    if (price <= 0n) return;
    this.db.sql
      .prepare(
        `UPDATE MiningCohorts
        SET argonotPriceAtBid = $price, updatedAt = CURRENT_TIMESTAMP
        WHERE id = $cohortId AND argonotPriceAtBid = '0'`,
      )
      .run(toSqliteParams({ cohortId, price }));
  }

  public fetchActiveSeatData(
    frameId: number,
    frameProgress: number,
  ): { seatCountActive: number; seatCostTotalFramed: bigint } {
    const rows = this.db.sql
      .prepare(
        `SELECT seatCountWon, microgonsBidPerSeat
        FROM MiningCohorts
        WHERE id <= $frameId AND id >= $firstActiveCohortId`,
      )
      .all({
        $frameId: frameId,
        $firstActiveCohortId: frameId - NetworkConfig.framesPerCohort + 1,
      }) as SqlCohortRow[];
    const cohorts = convertFromSqliteFields<Pick<IMiningCohort, 'seatCountWon' | 'microgonsBidPerSeat'>[]>(rows, {
      bigint: ['microgonsBidPerSeat'],
    });
    let seatCountActive = 0;
    let seatCostTotal = 0n;
    for (const cohort of cohorts) {
      seatCountActive += cohort.seatCountWon;
      seatCostTotal += cohort.microgonsBidPerSeat * BigInt(cohort.seatCountWon);
    }

    const framedCost = BigNumber(seatCostTotal.toString())
      .dividedBy(NetworkConfig.framesPerCohort)
      .multipliedBy(BigNumber(frameProgress).dividedBy(100));
    return {
      seatCountActive,
      seatCostTotalFramed: bigNumberToBigInt(framedCost),
    };
  }

  public fetchSummary(): Pick<IMiningSummary, 'cohorts' | 'global'> {
    const rows = this.db.sql.prepare('SELECT * FROM MiningCohorts ORDER BY id ASC').all() as SqlCohortRow[];
    const cohorts = convertFromSqliteFields<IMiningCohort[]>(rows, { bigint: bigintFields });
    const earningsByCohortId = new Map<
      number,
      Pick<
        IMiningCohortFrame,
        'micronotsMinedTotal' | 'microgonsMinedTotal' | 'microgonsMintedTotal' | 'microgonFeesCollectedTotal'
      >
    >();
    let micronotsMinedTotal = 0n;
    let microgonsMinedTotal = 0n;
    let microgonsMintedTotal = 0n;
    for (const frame of this.fetchCohortFrames()) {
      const totals = earningsByCohortId.get(frame.cohortId) ?? {
        micronotsMinedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
      };
      totals.micronotsMinedTotal += frame.micronotsMinedTotal;
      totals.microgonsMinedTotal += frame.microgonsMinedTotal;
      totals.microgonsMintedTotal += frame.microgonsMintedTotal;
      totals.microgonFeesCollectedTotal += frame.microgonFeesCollectedTotal;
      earningsByCohortId.set(frame.cohortId, totals);

      micronotsMinedTotal += frame.micronotsMinedTotal;
      microgonsMinedTotal += frame.microgonsMinedTotal;
      microgonsMintedTotal += frame.microgonsMintedTotal;
    }

    const financialPositions: IMiningCohortFinancial[] = [];
    let seatsTotal = 0;
    let accruedProgress = 0;
    let transactionFeesTotal = 0n;
    let microgonsBidTotal = 0n;
    let framedCost = BigNumber(0);
    for (const cohort of cohorts) {
      const seatCost = cohort.microgonsBidPerSeat * BigInt(cohort.seatCountWon);
      transactionFeesTotal += cohort.transactionFeesTotal;
      microgonsBidTotal += seatCost;
      framedCost = framedCost.plus(
        BigNumber((cohort.transactionFeesTotal + seatCost).toString())
          .multipliedBy(cohort.progress)
          .dividedBy(100),
      );
      financialPositions.push({
        ...cohort,
        ...(earningsByCohortId.get(cohort.id) ?? {
          micronotsMinedTotal: 0n,
          microgonsMinedTotal: 0n,
          microgonsMintedTotal: 0n,
          microgonFeesCollectedTotal: 0n,
        }),
      });
      if (cohort.seatCountWon <= 0) continue;

      seatsTotal += cohort.seatCountWon;
      accruedProgress += cohort.progress * cohort.seatCountWon;
    }

    const framesExpected = BigNumber(seatsTotal).multipliedBy(NetworkConfig.framesPerCohort);
    const framesCompleted = BigNumber(accruedProgress).dividedBy(NetworkConfig.framesPerCohort).toNumber();
    return {
      cohorts: financialPositions,
      global: {
        seatsTotal,
        framesCompleted,
        framesRemaining: framesExpected.minus(framesCompleted).toNumber(),
        framedCost: bigNumberToBigInt(framedCost),
        transactionFeesTotal,
        microgonsBidTotal,
        micronotsMinedTotal,
        microgonsMinedTotal,
        microgonsMintedTotal,
      },
    };
  }

  private fetchCohortFrames(): IMiningCohortFrame[] {
    const rows = this.db.sql.prepare('SELECT * FROM MiningCohortFrames').all() as SqlCohortFrameRow[];
    return convertFromSqliteFields<IMiningCohortFrame[]>(rows, {
      bigint: ['micronotsMinedTotal', 'microgonsMinedTotal', 'microgonsMintedTotal', 'microgonFeesCollectedTotal'],
    });
  }
}
