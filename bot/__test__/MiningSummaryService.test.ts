import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type IBidsFile, type IEarningsFile, NetworkConfig } from '@argonprotocol/apps-core';
import { MiningDb } from '../src/MiningDb.ts';
import { MiningSummaryService } from '../src/MiningSummaryService.ts';

describe('MiningSummaryService', () => {
  const datadirs: string[] = [];

  beforeAll(() => {
    NetworkConfig.setNetwork('mainnet');
  });

  afterEach(() => {
    for (const datadir of datadirs.splice(0)) {
      rmSync(datadir, { recursive: true, force: true });
    }
  });

  it('builds a server-owned mining snapshot from the existing bid and earnings files', async () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-summary-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    const { storage } = createStorage();
    const service = new MiningSummaryService(
      db,
      storage as any,
      {
        minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(20_000n),
      } as any,
      {
        waitForFrameId: vi.fn().mockResolvedValue(undefined),
        getTickStart: vi.fn().mockReturnValue(1_200),
      } as any,
    );

    const summary = await service.getSummary({
      currentFrameId: 12,
      finalizedFrameId: 11,
      oldestFrameIdToSync: 12,
      argonBlockNumbers: { localNode: 110, mainNode: 110 },
      earningsLastModifiedAt: new Date('2026-07-28T12:00:00Z'),
    });

    expect(summary).toMatchObject({
      latestFrameId: 12,
      sourceBlockNumber: 110,
      currentBids: [
        {
          frameId: 12,
          address: '5-current',
          subAccountIndex: 0,
          microgonsPerSeat: 700n,
          micronotsStakedPerSeat: 1_000n,
        },
      ],
      cohorts: [
        {
          id: 12,
          seatCountWon: 1,
          micronotsMinedTotal: 10n,
          microgonsMinedTotal: 20n,
          microgonsMintedTotal: 30n,
          microgonFeesCollectedTotal: 40n,
        },
      ],
    });
    expect(summary.frames).toEqual([
      expect.objectContaining({
        id: 12,
        blocksMinedTotal: 1,
        micronotsMinedTotal: 10n,
        microgonsMinedTotal: 20n,
        microgonsMintedTotal: 30n,
        microgonFeesCollectedTotal: 40n,
      }),
    ]);

    db.close();
  });

  it('retries incomplete projections and rebuilds mutable frames after a same-height update', async () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-summary-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    const source = createStorage();
    source.setFilesExist(false);
    const service = new MiningSummaryService(
      db,
      source.storage as any,
      {
        minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(20_000n),
      } as any,
      {
        waitForFrameId: vi.fn().mockResolvedValue(undefined),
        getTickStart: vi.fn().mockReturnValue(1_200),
      } as any,
    );
    const state = {
      currentFrameId: 12,
      finalizedFrameId: 11,
      oldestFrameIdToSync: 12,
      argonBlockNumbers: { localNode: 110, mainNode: 110 },
      earningsLastModifiedAt: new Date('2026-07-28T12:00:00Z'),
    };

    await expect(service.getSummary(state)).rejects.toThrow('Mining summary is still syncing.');

    source.setFilesExist(true);
    state.earningsLastModifiedAt = new Date('2026-07-28T12:00:01Z');
    const restored = await service.getSummary(state);
    expect(restored.frames[0].microgonsMinedTotal).toBe(20n);

    source.earnings.earningsByBlock[105].microgonsMined = 99n;
    state.earningsLastModifiedAt = new Date('2026-07-28T12:00:02Z');
    const reorged = await service.getSummary(state);
    expect(reorged.frames[0].microgonsMinedTotal).toBe(99n);
    expect(reorged.cohorts[0].microgonsMinedTotal).toBe(99n);

    source.setFilesExist(false);
    state.currentFrameId = 13;
    state.finalizedFrameId = 12;
    state.earningsLastModifiedAt = new Date('2026-07-28T12:00:03Z');
    const incomplete = await service.getSummary(state);
    expect(incomplete.frames.some(frame => frame.id === 13)).toBe(false);

    source.setFilesExist(true);
    const caughtUp = await service.getSummary(state);
    expect(caughtUp.frames.find(frame => frame.id === 13)?.microgonsMinedTotal).toBe(99n);

    db.close();
  });

  it('completes an empty projection while the chain is still in frame zero', async () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-summary-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    const source = createStorage();
    source.setFilesExist(false);
    const service = new MiningSummaryService(
      db,
      source.storage as any,
      {
        minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(20_000n),
      } as any,
      {
        waitForFrameId: vi.fn().mockResolvedValue(undefined),
        getTickStart: vi.fn().mockReturnValue(0),
      } as any,
    );

    await expect(
      service.refresh({
        currentFrameId: 0,
        finalizedFrameId: 0,
        oldestFrameIdToSync: 0,
        argonBlockNumbers: { localNode: 0, mainNode: 0 },
        earningsLastModifiedAt: new Date('2026-07-28T12:00:00Z'),
      }),
    ).resolves.toBe(true);

    expect(db.frames.fetchLast()).toEqual([]);
    db.close();
  });

  it('does not project an impossible cohort zero while recovering from genesis', async () => {
    const datadir = mkdtempSync(join(tmpdir(), 'argon-mining-summary-'));
    datadirs.push(datadir);

    const db = new MiningDb(datadir);
    db.migrate();
    const { storage } = createStorage();
    const service = new MiningSummaryService(
      db,
      storage as any,
      {
        minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(20_000n),
      } as any,
      {
        waitForFrameId: vi.fn().mockResolvedValue(undefined),
        getTickStart: vi.fn().mockReturnValue(100),
      } as any,
    );

    const summary = await service.getSummary({
      currentFrameId: 1,
      finalizedFrameId: 0,
      oldestFrameIdToSync: 0,
      argonBlockNumbers: { localNode: 10, mainNode: 10 },
      earningsLastModifiedAt: new Date('2026-07-28T12:00:00Z'),
    });

    expect(summary.cohorts.map(cohort => cohort.id)).toEqual([1]);
    db.close();
  });
});

function createStorage() {
  let filesExist = true;
  const cohortBids: IBidsFile = {
    cohortBiddingFrameId: 11,
    cohortActivationFrameId: 12,
    biddingFrameFirstTick: 1_100,
    biddingFrameRewardTicksRemaining: 0,
    lastBlockNumber: 99,
    microgonsBidTotal: 500n,
    argonotPriceAtBid: 3_000_000n,
    transactionFeesByBlock: { 99: 5n },
    micronotsStakedPerSeat: 1_000n,
    microgonsToBeMinedPerBlock: 100n,
    seatCountWon: 1,
    allMinersCount: 10,
    winningBids: [
      {
        address: '5-cohort',
        subAccountIndex: 0,
        bidPosition: 0,
        microgonsPerSeat: 500n,
      },
    ],
  };
  const currentBids: IBidsFile = {
    ...cohortBids,
    cohortBiddingFrameId: 12,
    cohortActivationFrameId: 13,
    lastBlockNumber: 110,
    winningBids: [
      {
        address: '5-current',
        subAccountIndex: 0,
        bidPosition: 0,
        microgonsPerSeat: 700n,
      },
    ],
  };
  const earnings: IEarningsFile = {
    frameId: 12,
    frameFirstTick: 1_200,
    frameRewardTicksRemaining: 0,
    firstBlockNumber: 100,
    lastBlockNumber: 110,
    microgonToUsd: [1_000_000n],
    microgonToBtc: [2_000n],
    microgonToArgonot: [3_000_000n],
    transactionFeesTotal: 5n,
    accruedMicrogonProfits: 45n,
    accruedMicronotProfits: 10n,
    previousFrameAccruedMicrogonProfits: 0n,
    previousFrameAccruedMicronotProfits: 0n,
    earningsByBlock: {
      105: {
        blockHash: '0x105',
        blockMinedAt: new Date().toISOString(),
        authorCohortActivationFrameId: 12,
        authorAddress: '5-cohort',
        microgonsMined: 20n,
        microgonsMinted: 30n,
        micronotsMined: 10n,
        microgonFeesCollected: 40n,
      },
    },
  };

  const storage = {
    bidsFile: (biddingFrameId: number) => ({
      exists: async () => filesExist,
      get: async () => (biddingFrameId === 12 ? currentBids : cohortBids),
    }),
    earningsFile: () => ({
      exists: async () => filesExist,
      get: async () => earnings,
    }),
  };
  return {
    storage,
    earnings,
    setFilesExist(value: boolean) {
      filesExist = value;
    },
  };
}
