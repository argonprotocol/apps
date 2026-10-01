import { afterEach, expect, it, vi } from 'vitest';
import {
  type IBidsFile,
  type IBotState,
  type IEarningsFile,
  type Mining,
  type MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { BotStatus, BotSyncer, type IBotFns } from '../lib/BotSyncer.ts';
import { MyMiningSeats } from '../lib/MyMiningSeats.ts';
import { botEmitter } from '../lib/Bot.ts';
import type { BotWsClient } from '../lib/BotWsClient.ts';
import type { Config } from '../lib/Config.ts';
import type { Currency } from '../lib/Currency.ts';
import type Installer from '../lib/Installer.ts';
import type { ServerApiClient } from '../lib/ServerApiClient.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';

afterEach(() => {
  botEmitter.all.clear();
  vi.restoreAllMocks();
});

it('preserves committed metrics through partial recovery, rollback, restart and a mounted consumer retry', async () => {
  const db = await createTestDb();
  const config = {
    oldestFrameIdToSync: 12,
    latestFrameIdProcessed: 999,
    isLoadedPromise: Promise.resolve(),
    save: vi.fn(),
    hasMiningSeats: true,
    hasMiningBids: true,
  } as unknown as Config;
  const miningFrames = {
    currentFrameId: 14,
    framesById: {},
    load: async () => undefined,
    waitForFrameId: async () => undefined,
    getTickStart: (id: number) => id * 1_440,
    getFrameDate: (id: number) => new Date(Date.UTC(2026, 8, id)),
  } as unknown as MiningFrames;
  const botFns: IBotFns = {
    onEvent: vi.fn((type, payload) => botEmitter.emit(type, payload)),
    setStatus: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setDbHistoryError: vi.fn(),
    setBotState: vi.fn(),
  };
  const state = {
    isReady: true,
    isSyncing: false,
    currentFrameId: 14,
    finalizedFrameId: 14,
    lastFinalizedProcessedBlockNumber: 1_400,
    oldestFrameIdToSync: 12,
    botLastActiveBlockNumber: 1_400,
    currentAuctionMicronotsPerSeat: 20n,
    winningBids: [{ address: 'live-bid', subAccountIndex: 0, microgonsPerSeat: 42n }],
  } as IBotState;
  let filesAreAvailable = false;
  let currentFrameMicrogons = 140n;
  const fetch = vi.fn(async (route: string, id: number) => {
    if (route === '/earnings') {
      const earnings = earningsFile(id);
      if (id === 12) {
        earnings.earningsByBlock[1_201] = {
          ...earnings.earningsByBlock[1_200],
          authorCohortActivationFrameId: 11,
          microgonsMined: 999n,
        };
      }
      if (id === 13) {
        earnings.earningsByBlock[1_301] = {
          ...earnings.earningsByBlock[1_300],
          authorAddress: 'another-miner',
          microgonsMined: 0n,
          micronotsMined: 0n,
          microgonFeesCollected: 0n,
          microgonsMinted: 30n,
          microgonsMintedByCohort: { 12: 20n, 13: 10n },
        };
      }
      if (id === 14) earnings.earningsByBlock[1_400].microgonsMined = currentFrameMicrogons;
      return earnings;
    }
    if (route === '/bids') {
      const bids = bidsFile(id + 1);
      if (id === 11) delete bids.argonotPriceAtBid;
      if (id === 13 && !filesAreAvailable) bids.lastBlockNumber = 0;
      return bids;
    }
    throw new Error(`Unexpected route ${route}`);
  });
  const client = { fetch } as unknown as BotWsClient;
  const mining = {
    minimumMicronotsMinedDuringTickRange: async () => 1_000n,
  } as unknown as Mining;
  const syncer = new BotSyncer(config, db, {} as Installer, {} as ServerApiClient, mining, miningFrames, botFns);
  vi.spyOn(syncer, 'getClient').mockResolvedValue(client);
  Object.assign(syncer, { botState: state });
  const seats = new MyMiningSeats(
    Promise.resolve(db),
    config,
    { isLoadedPromise: Promise.resolve(), microgonsPer: { ARGNOT: 2_000_000n } } as Currency,
    miningFrames,
  );
  try {
    await syncer['updateBotState']({ ...state, isSyncing: true, hasMiningSeats: false, hasMiningBids: false });
    expect(config.hasMiningSeats).toBe(true);
    expect(config.hasMiningBids).toBe(true);
    await seats.load();
    await seats.subscribeToDashboard();
    const aggregateReads = vi.spyOn(db.cohortsTable, 'fetchGlobalStats');
    await syncer['syncCurrentBids'](state);
    botEmitter.emit('updated-current-bids', 14);
    await vi.waitFor(() => expect(seats.pendingBids.microgonsBidTotal).toBe(42n));

    // Fail after a frame and its cohort have been written, before its rollup commits.
    await db.execute(`CREATE TRIGGER fail_rollup BEFORE INSERT ON CohortFrames
      WHEN NEW.frameId = 13 BEGIN SELECT RAISE(ABORT, 'rollup unavailable'); END`);
    await syncer['syncThePast'](state);
    await vi.waitFor(() =>
      expect(botFns.setDbHistoryError).toHaveBeenCalledWith(expect.stringContaining('rollup unavailable')),
    );
    await vi.waitFor(() => expect(seats.global.microgonsMinedTotal).toBe(120n));
    expect(aggregateReads).toHaveBeenCalledOnce();
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 3)).toEqual([12]);
    expect(await db.cohortsTable.fetchCohortIdsSince(12, 3)).toEqual([12]);
    expect((await db.cohortsTable.fetchFinancialPositions(12))[0].argonotPriceAtBid).toBe(2_000_000n);
    expect(db.framesTable.state.processedFrames[13]).toBeUndefined();
    expect(db.cohortsTable.state.storedCohorts[13]).toBeUndefined();
    expect(config.latestFrameIdProcessed).toBe(999);
    expect(seats.selectedFrameId).toBe(14);
    expect(seats.pendingBids.microgonsBidTotal).toBe(42n);

    await db.execute('DROP TRIGGER fail_rollup');
    syncer.dispose();
    // A new service must use the durable gap, even with a config cursor ahead of it.
    const restarted = new BotSyncer(config, db, {} as Installer, {} as ServerApiClient, mining, miningFrames, botFns);
    vi.spyOn(restarted, 'getClient').mockResolvedValue(client);
    Object.assign(restarted, { botState: state });
    fetch.mockClear();
    aggregateReads.mockClear();
    await restarted['syncThePast'](state);
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    await vi.waitFor(() => expect(seats.global.microgonsMinedTotal).toBe(250n));
    expect(aggregateReads).toHaveBeenCalledOnce();
    expect(seats.global.microgonsMintedTotal).toBe(30n);
    expect(await db.select('SELECT blocksMinedTotal FROM Frames WHERE id = 13')).toEqual([{ blocksMinedTotal: 1 }]);
    const mintRollups = await db.select<{ cohortId: number; microgonsMintedTotal: number }[]>(
      'SELECT cohortId, microgonsMintedTotal FROM CohortFrames WHERE frameId = 13 ORDER BY cohortId',
    );
    expect(mintRollups).toEqual([
      { cohortId: 12, microgonsMintedTotal: 20 },
      { cohortId: 13, microgonsMintedTotal: 10 },
    ]);
    expect(fetch.mock.calls.some(([route, id]) => route === '/earnings' && id === 12)).toBe(false);
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 3)).toEqual([12, 13]);
    expect(await db.cohortsTable.fetchCohortIdsSince(12, 3)).toEqual([12, 13]);

    // Missing files are not cached as authoritative zeros. The same service retries them.
    filesAreAvailable = true;
    const read = vi
      .spyOn(db.cohortsTable, 'fetchFinancialPositions')
      .mockRejectedValueOnce(new Error('reader unavailable'));
    const historyReadError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await restarted['syncThePast'](state);
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    await vi.waitFor(() =>
      expect(historyReadError).toHaveBeenCalledWith(
        '[MyMiningSeats] Unable to refresh current mining state',
        expect.objectContaining({ message: 'reader unavailable' }),
      ),
    );
    // The next live bot update retries a failed observer refresh without another full import.
    botEmitter.emit('updated-current-bids', 14);
    await vi.waitFor(() => expect(seats.global.microgonsMinedTotal).toBe(390n));
    expect(seats.selectedFrameId).toBe(14);
    expect(seats.frames.at(-1)?.id).toBe(14);
    expect(seats.pendingBids.microgonsBidTotal).toBe(42n);
    expect(restarted['calculateDbSyncProgress'](state)).toBe(100);
    read.mockRestore();
    historyReadError.mockRestore();

    // A state update with unchanged earnings must not rediscover or fetch the full history.
    const processedIdsRead = vi.spyOn(db.framesTable, 'fetchProcessedFrameIdsSince');
    fetch.mockClear();
    await restarted['syncThePast'](state);
    expect(processedIdsRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    // New earnings refresh only the current frame; a restart above rediscovered the durable gap.
    const cohortReads = vi.spyOn(db.cohortsTable, 'fetchFinancialPositions');
    currentFrameMicrogons = 145n;
    const updatedState = { ...state, earningsLastModifiedAt: new Date(1_000) };
    Object.assign(restarted, { botState: updatedState });
    vi.mocked(botFns.setDbHistoryError).mockClear();
    await restarted['syncThePast'](updatedState);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/earnings', 14));
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    await vi.waitFor(() => expect(seats.global.microgonsMinedTotal).toBe(395n));
    expect(cohortReads).toHaveBeenCalledWith(14 - NetworkConfig.framesPerCohort);
    expect(cohortReads).not.toHaveBeenCalledWith(0);
    expect(fetch.mock.calls.filter(([route]) => route === '/earnings').map(([, id]) => id)).toEqual([14]);
    expect(processedIdsRead).not.toHaveBeenCalled();
    processedIdsRead.mockRestore();
    cohortReads.mockRestore();

    // Repeated earnings use the shared cache instead of rewriting an unchanged rollup.
    await db.execute(`CREATE TRIGGER unchanged_rollup BEFORE INSERT ON CohortFrames
      BEGIN SELECT RAISE(ABORT, 'unchanged rollup rewritten'); END`);
    await restarted.syncDbFrame(14, state);
    await db.execute('DROP TRIGGER unchanged_rollup');

    // Neither missing nor stale server history can replace the valid financial snapshot.
    fetch.mockImplementationOnce(async () => ({ ...earningsFile(14), lastBlockNumber: 0 }));
    await expect(restarted.syncDbFrame(14, state)).rejects.toThrow('not been recovered');
    fetch.mockImplementationOnce(async () => ({ ...earningsFile(14), lastBlockNumber: 1 }));
    await expect(restarted.syncDbFrame(14, state)).rejects.toThrow('older than the saved data');
    expect((await db.cohortsTable.fetchGlobalStats()).microgonsMinedTotal).toBe(395n);
    expect((await db.cohortsTable.fetchGlobalStats()).microgonsMintedTotal).toBe(30n);

    // Viewing live follows a new frame even before its historical metrics are available.
    await restarted['syncCurrentBids']({ ...state, currentFrameId: 15 });
    botEmitter.emit('updated-current-bids', 15);
    await vi.waitFor(() => expect(seats.latestFrameId).toBe(15));
    expect(seats.selectedFrameId).toBe(15);
    expect(seats.frames.at(-1)?.id).toBe(14);

    // A failing bid read preserves the last snapshot and the next update recovers it.
    seats.selectFrameId(13, { isUserAction: true, skipDashboardUpdate: true });
    await restarted['syncCurrentBids']({ ...state, currentFrameId: 16 });
    const bidRead = vi
      .spyOn(db.frameBidsTable, 'fetchForFrameId')
      .mockRejectedValueOnce(new Error('bid reader unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    botEmitter.emit('updated-current-bids', 16);
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(
        '[MyMiningSeats] Unable to refresh current mining state',
        expect.objectContaining({ message: 'bid reader unavailable' }),
      ),
    );
    expect(seats.latestFrameId).toBe(15);
    expect(seats.pendingBids.microgonsBidTotal).toBe(42n);
    botEmitter.emit('updated-current-bids', 16);
    await vi.waitFor(() => expect(seats.latestFrameId).toBe(16));
    expect(seats.selectedFrameId).toBe(13);
    expect(seats.global.microgonsMinedTotal).toBe(395n);
    bidRead.mockRestore();
    errorLog.mockRestore();

    restarted.dispose();
  } finally {
    seats.unsubscribeFromDashboard();
    syncer.dispose();
    await db.close();
  }
});

it.each([0, 12])('retries failed history discovery starting at frame %s', async oldestFrameId => {
  NetworkConfig.setNetwork('dev-docker');
  const db = await createTestDb();
  const currentFrameId = Math.max(2, oldestFrameId);
  const config = { oldestFrameIdToSync: 12, latestFrameIdProcessed: 12, save: vi.fn() } as unknown as Config;
  const botFns: IBotFns = {
    onEvent: vi.fn(),
    setStatus: vi.fn(),
    setBotState: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setDbHistoryError: vi.fn(),
  };
  const syncer = new BotSyncer(
    config,
    db,
    {} as Installer,
    {} as ServerApiClient,
    { minimumMicronotsMinedDuringTickRange: async () => 1_000n } as unknown as Mining,
    {
      waitForFrameId: async () => undefined,
      getTickStart: () => 17_280,
      blockWatch: { getBlockTime: async () => new Date() },
    } as unknown as MiningFrames,
    botFns,
  );
  const state = {
    isReady: true,
    isSyncing: false,
    oldestFrameIdToSync: oldestFrameId,
    currentFrameId,
    finalizedFrameId: currentFrameId + 1,
    lastFinalizedProcessedBlockNumber: (currentFrameId + 1) * 100,
    winningBids: [],
    botLastActiveBlockNumber: 1_200,
    bitcoinBlockNumbers: { localNode: 0, mainNode: 0, localNodeBlockTime: 0 },
    argonBlockNumbers: { localNode: 0, mainNode: 0 },
  } as unknown as IBotState;
  Object.assign(syncer, { botState: state });
  try {
    const discover = vi
      .spyOn(db.framesTable, 'fetchProcessedFrameIdsSince')
      .mockRejectedValueOnce(new Error('discovery unavailable'));
    await syncer['runSync'](state);
    await vi.waitFor(() =>
      expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(expect.stringContaining('discovery unavailable')),
    );
    expect(botFns.setStatus).toHaveBeenLastCalledWith(BotStatus.Ready);
    expect(botFns.setStatus).not.toHaveBeenCalledWith(BotStatus.Broken);
    discover.mockRestore();
    vi.spyOn(syncer, 'getClient').mockResolvedValue({
      fetch: async (route: string, id: number) => {
        if (route === '/earnings') return earningsFile(id);
        const bids = bidsFile(id + 1);
        if (id === -1) bids.lastBlockNumber = 1;
        return bids;
      },
    } as unknown as BotWsClient);
    await syncer['runSync'](state);
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    expect(config.oldestFrameIdToSync).toBe(oldestFrameId);
    expect(await db.framesTable.fetchProcessedFrameIdsSince(oldestFrameId, currentFrameId - oldestFrameId + 1)).toEqual(
      Array.from({ length: currentFrameId - oldestFrameId + 1 }, (_, i) => oldestFrameId + i),
    );
    expect(syncer['calculateDbSyncProgress'](state)).toBe(100);
  } finally {
    syncer.dispose();
    await db.close();
  }
});

it('retries an older incomplete frame without showing routine frame rollover as historical recovery', async () => {
  const db = await createTestDb();
  const config = { oldestFrameIdToSync: 12, save: vi.fn() } as unknown as Config;
  const botFns: IBotFns = {
    onEvent: vi.fn(),
    setStatus: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setDbHistoryError: vi.fn(),
    setBotState: vi.fn(),
  };
  const syncer = new BotSyncer(
    config,
    db,
    {} as Installer,
    {} as ServerApiClient,
    { minimumMicronotsMinedDuringTickRange: async () => 1_000n } as unknown as Mining,
    { waitForFrameId: async () => undefined, getTickStart: (id: number) => id * 1_440 } as unknown as MiningFrames,
    botFns,
  );
  let frame13Remaining = 1;
  const fetch = vi.fn(async (route: string, id: number) => {
    if (route === '/earnings') {
      const remaining = id === 13 ? frame13Remaining : id >= 14 ? 1 : 0;
      return { ...earningsFile(id), frameRewardTicksRemaining: remaining };
    }
    if (route === '/bids') return bidsFile(id + 1);
    throw new Error(`Unexpected route ${route}`);
  });
  vi.spyOn(syncer, 'getClient').mockResolvedValue({ fetch } as unknown as BotWsClient);
  const state = {
    isReady: true,
    isSyncing: false,
    oldestFrameIdToSync: 12,
    currentFrameId: 14,
    finalizedFrameId: 14,
    lastFinalizedProcessedBlockNumber: 1_400,
    earningsLastModifiedAt: new Date(1_000),
  } as IBotState;
  Object.assign(syncer, { botState: state });

  try {
    await syncer['syncThePast'](state);
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 3)).toEqual([12]);
    expect(syncer['calculateDbSyncProgress'](state)).toBe(100);

    frame13Remaining = 0;
    const nextState = {
      ...state,
      currentFrameId: 15,
      finalizedFrameId: 15,
      lastFinalizedProcessedBlockNumber: 1_500,
      earningsLastModifiedAt: new Date(2_000),
    };
    Object.assign(syncer, { botState: nextState });
    vi.mocked(botFns.setDbHistoryError).mockClear();
    await syncer['syncThePast'](nextState);
    await vi.waitFor(() => expect(botFns.setDbHistoryError).toHaveBeenLastCalledWith(null));
    expect(fetch.mock.calls.filter(([route, id]) => route === '/earnings' && id === 13)).toHaveLength(2);
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 4)).toEqual([12, 13]);
    expect(syncer['calculateDbSyncProgress'](nextState)).toBe(100);
  } finally {
    syncer.dispose();
    await db.close();
  }
});

it('repairs prematurely completed imports and replaces provisional fork earnings and cohort terms before finalization', async () => {
  const { db, migrateToLatest } = await createTestDbAtMigration(34);
  await db.execute(`INSERT INTO Frames
    (id, firstTick, rewardTicksRemaining, firstBlockNumber, lastBlockNumber, progress, isProcessed, microgonsMinedTotal)
    VALUES (12, 17280, 0, 1200, 1299, 100, 1, 999)`);
  await migrateToLatest();
  expect(await db.select('SELECT isProcessed, microgonsMinedTotal FROM Frames WHERE id = 12')).toEqual([
    { isProcessed: 0, microgonsMinedTotal: 999 },
  ]);

  const config = { oldestFrameIdToSync: 12, save: vi.fn() } as unknown as Config;
  const mining = { minimumMicronotsMinedDuringTickRange: async () => 1_000n } as unknown as Mining;
  const miningFrames = {
    waitForFrameId: async () => undefined,
    getTickStart: (id: number) => id * 1_440,
  } as unknown as MiningFrames;
  const botFns: IBotFns = {
    onEvent: vi.fn(),
    setStatus: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setDbHistoryError: vi.fn(),
    setBotState: vi.fn(),
  };
  const state = {
    isReady: true,
    isSyncing: false,
    currentFrameId: 14,
    finalizedFrameId: 13,
    lastFinalizedProcessedBlockNumber: 1_299,
    oldestFrameIdToSync: 12,
    earningsLastModifiedAt: new Date(1_000),
  } as IBotState;
  let forkReplaced = false;
  let shorterTip = false;
  let auctionAvailable = true;
  const fetch = vi.fn(async (route: string, id: number) => {
    if (route === '/earnings') {
      const earnings = earningsFile(id);
      if (id === 13 && forkReplaced) {
        earnings.earningsByBlock[1_300].blockHash = 'canonical-block';
        earnings.earningsByBlock[1_300].microgonsMined = 70n;
      }
      if (id === 13 && shorterTip) {
        earnings.lastBlockNumber = 1_301;
        earnings.earningsByBlock[1_300].microgonsMined = 70n;
      }
      return earnings;
    }
    if (route === '/bids') {
      const bids = bidsFile(id + 1);
      if (id === 12) {
        Object.assign(bids, { seatCountWon: forkReplaced ? 2 : 1, microgonsBidTotal: forkReplaced ? 20n : 10n });
        if (!auctionAvailable) Object.assign(bids, { lastBlockNumber: 0, seatCountWon: 0, microgonsBidTotal: 0n });
      }
      return bids;
    }
    throw new Error(`Unexpected route ${route}`);
  });
  const client = { fetch } as unknown as BotWsClient;
  const syncer = new BotSyncer(config, db, {} as Installer, {} as ServerApiClient, mining, miningFrames, botFns);
  vi.spyOn(syncer, 'getClient').mockResolvedValue(client);
  Object.assign(syncer, { botState: state });
  try {
    await syncer['syncThePast'](state);
    await vi.waitFor(() => expect(syncer['isSyncingThePast']).toBe(false));
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 3)).toEqual([12]);
    expect(await db.select('SELECT microgonsMinedTotal FROM Frames WHERE id = 12')).toEqual([
      { microgonsMinedTotal: 120 },
    ]);

    // The reward period ended, but frame 13's tip is still provisional and must remain refreshable.
    expect(await db.select('SELECT progress, isProcessed FROM Frames WHERE id = 13')).toEqual([
      { progress: 100, isProcessed: 0 },
    ]);
    // The replacement chain can end before the saved provisional frame tip.
    shorterTip = true;
    await syncer.syncDbFrame(13, { ...state, lastProcessedBlockNumber: 1_301 });
    expect(await db.select('SELECT lastBlockNumber, microgonsMinedTotal FROM Frames WHERE id = 13')).toEqual([
      { lastBlockNumber: 1_301, microgonsMinedTotal: 70 },
    ]);
    shorterTip = false;

    // An invalidated auction cannot turn the previously imported cohort into a zero-seat result.
    auctionAvailable = false;
    const recoveringState = { ...state, lastProcessedBlockNumber: 1_299, earningsLastModifiedAt: new Date(1_500) };
    Object.assign(syncer, { botState: recoveringState });
    await syncer['syncThePast'](recoveringState);
    await vi.waitFor(() => expect(syncer['isSyncingThePast']).toBe(false));
    expect((await db.cohortsTable.fetchFinancialPositions(13))[0]).toMatchObject({ seatCountWon: 1 });
    expect(await db.select('SELECT lastBlockNumber, microgonsMinedTotal FROM Frames WHERE id = 13')).toEqual([
      { lastBlockNumber: 1_301, microgonsMinedTotal: 70 },
    ]);
    expect(db.framesTable.state.processedFrames[13]).toBeUndefined();

    auctionAvailable = true;
    forkReplaced = true;
    const finalizedState = { ...state, finalizedFrameId: 14, lastFinalizedProcessedBlockNumber: 1_399 };
    Object.assign(syncer, { botState: finalizedState });
    await syncer['syncThePast'](finalizedState);
    await vi.waitFor(() => expect(syncer['isSyncingThePast']).toBe(false));
    expect(await db.framesTable.fetchProcessedFrameIdsSince(12, 3)).toEqual([12, 13]);
    expect(await db.select('SELECT microgonsMinedTotal FROM Frames WHERE id = 13')).toEqual([
      { microgonsMinedTotal: 70 },
    ]);
    expect(
      await db.select('SELECT microgonsMinedTotal FROM CohortFrames WHERE frameId = 13 AND cohortId = 12'),
    ).toEqual([{ microgonsMinedTotal: 70 }]);
    expect((await db.cohortsTable.fetchFinancialPositions(13))[0]).toMatchObject({ seatCountWon: 2 });
    expect(db.cohortFramesTable.state.cache.get('13:12')?.microgonsMinedTotal).toBe(70n);

    syncer.dispose();
    const restarted = new BotSyncer(config, db, {} as Installer, {} as ServerApiClient, mining, miningFrames, botFns);
    vi.spyOn(restarted, 'getClient').mockResolvedValue(client);
    Object.assign(restarted, { botState: finalizedState });
    fetch.mockClear();
    await restarted['syncThePast'](finalizedState);
    await vi.waitFor(() => expect(restarted['isSyncingThePast']).toBe(false));
    expect(fetch.mock.calls.filter(([route]) => route === '/earnings').map(([, id]) => id)).toEqual([14]);
    expect(restarted['calculateDbSyncProgress'](finalizedState)).toBe(100);
    restarted.dispose();
  } finally {
    syncer.dispose();
    await db.close();
  }
});

function earningsFile(frameId: number): IEarningsFile {
  return {
    frameId,
    frameFirstTick: frameId * 1_440,
    frameRewardTicksRemaining: 0,
    firstBlockNumber: frameId * 100,
    lastBlockNumber: frameId * 100 + 99,
    microgonToUsd: [1_000_000n],
    microgonToBtc: [100_000n],
    microgonToArgonot: [2_000_000n],
    earningsByBlock: {
      [frameId * 100]: {
        blockHash: `block-${frameId}`,
        blockMinedAt: '2026-09-12T00:00:00Z',
        authorCohortActivationFrameId: 12,
        authorAddress: 'our-miner',
        microgonsMined: BigInt(frameId * 10),
        microgonsMinted: 0n,
        micronotsMined: 0n,
        microgonFeesCollected: 0n,
      },
    },
  };
}

function bidsFile(frameId: number): IBidsFile {
  return {
    cohortBiddingFrameId: frameId - 1,
    cohortActivationFrameId: frameId,
    biddingFrameRewardTicksRemaining: 0,
    lastBlockNumber: frameId * 100,
    seatCountWon: frameId === 12 ? 1 : 0,
    allMinersCount: 10,
    microgonsBidTotal: frameId === 12 ? 10n : 0n,
    argonotPriceAtBid: 2_000_000n,
    transactionFeesByBlock: {},
    micronotsStakedPerSeat: 20n,
    microgonsToBeMinedPerBlock: 100n,
  };
}
