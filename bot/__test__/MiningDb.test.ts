import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MiningDb } from '../src/MiningDb.ts';

describe('MiningDb', () => {
  const datadirs: string[] = [];

  afterEach(() => {
    for (const datadir of datadirs.splice(0)) {
      rmSync(datadir, { recursive: true, force: true });
    }
  });

  it('replaces an affected frame projection instead of accumulating reorged earnings', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-db-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();

    db.cohortFrames.replaceForFrame(20, [
      {
        frameId: 20,
        cohortId: 15,
        blocksMinedTotal: 2,
        micronotsMinedTotal: 20n,
        microgonsMinedTotal: 40n,
        microgonsMintedTotal: 60n,
        microgonFeesCollectedTotal: 80n,
      },
      {
        frameId: 20,
        cohortId: 16,
        blocksMinedTotal: 1,
        micronotsMinedTotal: 10n,
        microgonsMinedTotal: 20n,
        microgonsMintedTotal: 30n,
        microgonFeesCollectedTotal: 40n,
      },
    ]);
    db.cohortFrames.replaceForFrame(20, [
      {
        frameId: 20,
        cohortId: 15,
        blocksMinedTotal: 1,
        micronotsMinedTotal: 10n,
        microgonsMinedTotal: 20n,
        microgonsMintedTotal: 30n,
        microgonFeesCollectedTotal: 40n,
      },
    ]);

    expect(
      db.sql
        .prepare(
          `SELECT frameId, cohortId, blocksMinedTotal, micronotsMinedTotal
          FROM MiningCohortFrames
          WHERE frameId = 20
          ORDER BY cohortId`,
        )
        .all(),
    ).toEqual([{ frameId: 20, cohortId: 15, blocksMinedTotal: 1, micronotsMinedTotal: '10' }]);

    db.close();
  });

  it('aggregates mining values without losing bigint precision', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-db-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    const largeValue = 9_007_199_254_740_993n;

    const cohort = {
      id: 12,
      transactionFeesTotal: largeValue,
      micronotsStakedPerSeat: largeValue,
      microgonsBidPerSeat: largeValue,
      seatCountWon: 2,
      microgonsToBeMinedPerSeat: largeValue,
      micronotsToBeMinedPerSeat: largeValue,
      argonotPriceAtBid: 2_000_000n,
    };
    db.cohorts.insertOrUpdate(cohort);
    db.cohorts.insertOrUpdate({
      ...cohort,
      id: 13,
      transactionFeesTotal: 0n,
      seatCountWon: 0,
    });
    db.cohortFrames.replaceForFrame(12, [
      {
        frameId: 12,
        cohortId: 12,
        blocksMinedTotal: 1,
        micronotsMinedTotal: largeValue,
        microgonsMinedTotal: largeValue,
        microgonsMintedTotal: largeValue,
        microgonFeesCollectedTotal: largeValue,
      },
    ]);

    const summary = db.cohorts.fetchSummary();
    expect(summary.cohorts.map(x => x.id)).toEqual([12, 13]);
    expect(summary.cohorts[0]).toMatchObject({
      transactionFeesTotal: largeValue,
      micronotsMinedTotal: largeValue,
      microgonsMinedTotal: largeValue,
    });
    expect(summary.global).toMatchObject({
      transactionFeesTotal: largeValue,
      microgonsBidTotal: largeValue * 2n,
      micronotsMinedTotal: largeValue,
      microgonsMinedTotal: largeValue,
      microgonsMintedTotal: largeValue,
    });

    db.close();
  });

  it('preserves a closing price when a later refresh has a non-positive price', () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-db-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    db.cohorts.insertOrUpdate({
      id: 12,
      transactionFeesTotal: 0n,
      micronotsStakedPerSeat: 0n,
      microgonsBidPerSeat: 0n,
      seatCountWon: 0,
      microgonsToBeMinedPerSeat: 0n,
      micronotsToBeMinedPerSeat: 0n,
      argonotPriceAtBid: 0n,
    });
    db.cohorts.setClosingArgonotPrice(12, 2_000_000n);
    db.cohorts.setClosingArgonotPrice(12, 0n);
    db.cohorts.setClosingArgonotPrice(12, -1n);

    expect(db.cohorts.fetchSummary().cohorts).toMatchObject([{ id: 12, closingArgonotPrice: 2_000_000n }]);

    db.close();
  });
});
