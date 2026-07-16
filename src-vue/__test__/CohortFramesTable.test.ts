import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';

describe('CohortFramesTable', () => {
  it('round-trips a bid-time Argonot price above the SQLite integer range', async () => {
    const db = await createTestDb();
    const largeValue = 9_876_543_210_123_456_789n;

    try {
      await db.framesTable.insertOrUpdate({
        id: 13,
        firstTick: 13_000,
        rewardTicksRemaining: 0,
        firstBlockNumber: 1_300,
        lastBlockNumber: 1_399,
        microgonToUsd: [],
        microgonToBtc: [],
        microgonToArgonot: [],
        accruedMicrogonProfits: 0n,
        accruedMicronotProfits: 0n,
        progress: 100,
      });
      await db.cohortsTable.insertOrUpdate({
        id: 13,
        transactionFeesTotal: 0n,
        micronotsStakedPerSeat: 0n,
        microgonsBidPerSeat: 0n,
        seatCountWon: 1,
        microgonsToBeMinedPerSeat: 0n,
        micronotsToBeMinedPerSeat: 0n,
        argonotPriceAtBid: largeValue,
      });

      const [cohort] = await db.cohortsTable.fetchByIds([13]);
      expect(cohort.argonotPriceAtBid).toBe(largeValue);
    } finally {
      await db.close();
    }
  });

  it('caches synchronized cohorts when the historical price remains missing', async () => {
    const db = await createTestDb();
    try {
      await db.framesTable.insertOrUpdate({
        id: 11,
        firstTick: 11_000,
        rewardTicksRemaining: 0,
        firstBlockNumber: 1_100,
        lastBlockNumber: 1_199,
        microgonToUsd: [],
        microgonToBtc: [],
        microgonToArgonot: [],
        accruedMicrogonProfits: 0n,
        accruedMicronotProfits: 0n,
        progress: 100,
      });
      await db.cohortsTable.insertOrUpdate({
        id: 11,
        transactionFeesTotal: 0n,
        micronotsStakedPerSeat: 0n,
        microgonsBidPerSeat: 0n,
        seatCountWon: 0,
        microgonsToBeMinedPerSeat: 0n,
        micronotsToBeMinedPerSeat: 0n,
        argonotPriceAtBid: 0n,
      });

      await expect(db.cohortsTable.fetchCohortIdsSince(11, 1)).resolves.toEqual([11]);
    } finally {
      await db.close();
    }
  });

  it('values each cohort rewards at its bid-time argonot price', async () => {
    const db = await createTestDb();
    try {
      await Promise.all(
        [11, 12].map(id =>
          db.framesTable.insertOrUpdate({
            id,
            firstTick: id * 1_000,
            rewardTicksRemaining: 0,
            firstBlockNumber: id * 100,
            lastBlockNumber: id * 100 + 99,
            microgonToUsd: [],
            microgonToBtc: [],
            microgonToArgonot: [],
            accruedMicrogonProfits: 0n,
            accruedMicronotProfits: 0n,
            progress: 100,
          }),
        ),
      );
      await db.cohortsTable.insertOrUpdate({
        id: 11,
        transactionFeesTotal: 0n,
        micronotsStakedPerSeat: 0n,
        microgonsBidPerSeat: 0n,
        seatCountWon: 1,
        microgonsToBeMinedPerSeat: 0n,
        micronotsToBeMinedPerSeat: 0n,
        argonotPriceAtBid: 2_000_000n,
      });
      await db.cohortsTable.insertOrUpdate({
        id: 12,
        transactionFeesTotal: 0n,
        micronotsStakedPerSeat: 0n,
        microgonsBidPerSeat: 0n,
        seatCountWon: 1,
        microgonsToBeMinedPerSeat: 0n,
        micronotsToBeMinedPerSeat: 0n,
        argonotPriceAtBid: 4_000_000n,
      });
      await db.cohortFramesTable.insertOrUpdate({
        frameId: 12,
        cohortActivationFrameId: 11,
        blocksMinedTotal: 1,
        micronotsMinedTotal: 1_500_000n,
        microgonsMinedTotal: 1_000_000n,
        microgonsMintedTotal: 500_000n,
        microgonFeesCollectedTotal: 0n,
      });
      await db.cohortsTable.setArgonotPriceAtCompletion(11, 3_000_000n);
      await db.cohortsTable.updateProgress();
      await db.cohortFramesTable.insertOrUpdate({
        frameId: 12,
        cohortActivationFrameId: 12,
        blocksMinedTotal: 1,
        micronotsMinedTotal: 500_000n,
        microgonsMinedTotal: 2_000_000n,
        microgonsMintedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
      });

      const select = vi.spyOn(db, 'select');
      await expect(db.cohortsTable.fetchGlobalStats()).resolves.toEqual({
        seatsTotal: 2,
        framesCompleted: 3,
        framesRemaining: 17,
        framedCost: 0n,
        transactionFeesTotal: 0n,
        microgonsBidTotal: 0n,
        micronotsMinedTotal: 2_000_000n,
        microgonsMinedTotal: 3_000_000n,
        microgonsMintedTotal: 500_000n,
      });
      expect(select).toHaveBeenCalledOnce();
      await expect(db.cohortsTable.fetchFinancialPositions()).resolves.toEqual([
        expect.objectContaining({
          id: 11,
          argonotPriceAtBid: 2_000_000n,
          closingArgonotPrice: 3_000_000n,
          micronotsMinedTotal: 1_500_000n,
          microgonsMinedTotal: 1_000_000n,
          microgonsMintedTotal: 500_000n,
          microgonFeesCollectedTotal: 0n,
        }),
        expect.objectContaining({
          id: 12,
          argonotPriceAtBid: 4_000_000n,
          closingArgonotPrice: 0n,
          micronotsMinedTotal: 500_000n,
          microgonsMinedTotal: 2_000_000n,
          microgonsMintedTotal: 0n,
          microgonFeesCollectedTotal: 0n,
        }),
      ]);
    } finally {
      await db.sql.close();
    }
  });
});

describe('FramesTable', () => {
  it('returns a bounded argonot price range for callers to interpret', async () => {
    const db = await createTestDb();
    try {
      await Promise.all(
        [
          { id: 9, prices: [3_000_000n] },
          { id: 10, prices: [] },
          { id: 11, prices: [0n] },
          { id: 12, prices: [8_000_000n, 9_000_000n] },
          { id: 25, prices: [10_000_000n] },
        ].map(({ id, prices }) =>
          db.framesTable.insertOrUpdate({
            id,
            firstTick: id * 1_000,
            rewardTicksRemaining: 0,
            firstBlockNumber: id * 100,
            lastBlockNumber: id * 100 + 99,
            microgonToUsd: [],
            microgonToBtc: [],
            microgonToArgonot: prices,
            accruedMicrogonProfits: 0n,
            accruedMicronotProfits: 0n,
            progress: 100,
          }),
        ),
      );

      await expect(db.framesTable.fetchArgonotPricesNearFrame(11)).resolves.toEqual([
        { id: 9, microgonToArgonot: [3_000_000n] },
        { id: 10, microgonToArgonot: [] },
        { id: 11, microgonToArgonot: [0n] },
        { id: 12, microgonToArgonot: [8_000_000n, 9_000_000n] },
      ]);
    } finally {
      await db.sql.close();
    }
  });
});
