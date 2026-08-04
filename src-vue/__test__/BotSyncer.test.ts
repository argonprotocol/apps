import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotWsClient } from '../lib/BotWsClient.ts';
import { BotStatus, BotSyncer, type IBotFns } from '../lib/BotSyncer.ts';

type IBotSyncerTestTarget = {
  runSync(state: { isReady: boolean; isSyncing: boolean; serverError: string; currentFrameId?: number }): Promise<void>;
  syncThePast(
    progress: number,
    state: { oldestFrameIdToSync: number; currentFrameId: number; currentTick: number },
  ): Promise<void>;
  syncDbFrame(frameId: number): Promise<void>;
  syncDbCohort(cohortActivationFrameId: number): Promise<void>;
  updateBotState(state: { currentFrameId: number }): Promise<void>;
};

describe('BotSyncer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs off websocket auth failures instead of starting a new client each loop', async () => {
    const { syncer } = createSyncer();
    const connect = vi.spyOn(BotWsClient, 'connectToServerGateway').mockRejectedValue(new Error('auth failed'));

    await expect(syncer.getClient()).rejects.toThrow('auth failed');
    await expect(syncer.getClient()).rejects.toThrow('waiting before retrying');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale local gateway port before opening the websocket', async () => {
    const { syncer, installer } = createSyncer({ gatewayReady: false });
    vi.spyOn(BotWsClient, 'connectToServerGateway').mockRejectedValue(new Error('auth failed'));

    await expect(syncer.getClient()).rejects.toThrow('auth failed');

    expect(installer.refreshLocalGatewayPort).toHaveBeenCalledTimes(1);
  });

  it('disposes a websocket client that connects after the syncer is disposed', async () => {
    const { syncer } = createSyncer();
    let resolveClient!: (client: BotWsClient) => void;
    const connection = new Promise<BotWsClient>(resolve => {
      resolveClient = resolve;
    });
    const connect = vi.spyOn(BotWsClient, 'connectToServerGateway').mockReturnValue(connection);
    const dispose = vi.fn();
    const client = {
      dispose,
      events: { on: vi.fn() },
    } as unknown as BotWsClient;

    const pendingClient = syncer.getClient();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    syncer.dispose();
    resolveClient(client);

    await expect(pendingClient).rejects.toThrow('BotSyncer disposed');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not mark the bot broken for transient rpc errors', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    vi.spyOn(testSyncer, 'updateBotState').mockRejectedValue(
      new Error('No response received from RPC endpoint in 60s'),
    );

    await testSyncer.runSync({
      isReady: true,
      isSyncing: false,
      serverError: '',
      currentFrameId: 424,
    });

    expect(botFns.setStatus).not.toHaveBeenCalledWith(BotStatus.Broken);
    expect(botFns.setStatus).not.toHaveBeenCalled();
  });

  it('does not mark the bot broken for transient websocket event errors', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    vi.spyOn(testSyncer, 'updateBotState').mockRejectedValue({ isTrusted: true });

    await testSyncer.runSync({
      isReady: true,
      isSyncing: false,
      serverError: '',
      currentFrameId: 424,
    });

    expect(botFns.setStatus).not.toHaveBeenCalledWith(BotStatus.Broken);
  });

  it('marks the bot broken for explicit server errors', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;

    await testSyncer.runSync({
      isReady: false,
      isSyncing: false,
      serverError: 'server exploded',
    });

    expect(botFns.setStatus).toHaveBeenCalledWith(BotStatus.Broken);
  });

  it('marks the bot broken for unexpected sync errors', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    vi.spyOn(testSyncer, 'updateBotState').mockRejectedValue(new Error('bad state'));

    await testSyncer.runSync({
      isReady: true,
      isSyncing: false,
      serverError: '',
      currentFrameId: 424,
    });

    expect(botFns.setStatus).toHaveBeenCalledWith(BotStatus.Broken);
  });

  it('owns failures from background historical frame syncs', async () => {
    const { syncer } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(testSyncer, 'syncDbFrame').mockRejectedValue(error);

    await testSyncer.syncThePast(0, {
      oldestFrameIdToSync: 1,
      currentFrameId: 2,
      currentTick: 1,
    });

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('BotSyncer background sync error:', error);
    });
  });

  it('announces when historical cohort catch-up completes', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    vi.spyOn(testSyncer, 'syncDbFrame').mockResolvedValue(undefined);
    vi.spyOn(syncer as any, 'calculateDbSyncProgress').mockResolvedValue(100);

    await testSyncer.syncThePast(0, {
      oldestFrameIdToSync: 1,
      currentFrameId: 2,
      currentTick: 1,
    });

    await vi.waitFor(() => {
      expect(botFns.onEvent).toHaveBeenCalledWith('updated-cohort-history', 2);
    });
  });

  it('resumes historical sync at the first missing cohort instead of the latest frame cursor', async () => {
    const { syncer, config, framesTable, cohortsTable } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const syncDbFrame = vi.spyOn(testSyncer, 'syncDbFrame').mockRejectedValue(new Error('stop after first frame'));
    config.latestFrameIdProcessed = 865;
    framesTable.fetchLastProcessedFrame.mockResolvedValue(864);
    framesTable.fetchProcessedFrameIdsSince.mockResolvedValue(Array.from({ length: 817 }, (_, index) => index + 48));
    cohortsTable.fetchCohortIdsSince.mockResolvedValue(Array.from({ length: 407 }, (_, index) => index + 48));

    await testSyncer.syncThePast(98.6, {
      oldestFrameIdToSync: 48,
      currentFrameId: 865,
      currentTick: 1,
    });

    await vi.waitFor(() => {
      expect(syncDbFrame).toHaveBeenCalledWith(455, expect.anything());
    });
  });

  it('replays incomplete frames without downloading the processed frames between them', async () => {
    const { syncer, botFns, config, framesTable, cohortsTable } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const syncDbFrame = vi.spyOn(testSyncer, 'syncDbFrame').mockResolvedValue(undefined);
    vi.spyOn(syncer as any, 'calculateDbSyncProgress').mockResolvedValue(100);
    config.latestFrameIdProcessed = 8;
    framesTable.fetchLastProcessedFrame.mockResolvedValue(8);
    framesTable.fetchProcessedFrameIdsSince.mockResolvedValue([1, 2, 4, 5, 7, 8]);
    cohortsTable.fetchCohortIdsSince.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8]);

    await testSyncer.syncThePast(75, {
      oldestFrameIdToSync: 1,
      currentFrameId: 8,
      currentTick: 1,
    });

    await vi.waitFor(() => {
      expect(botFns.onEvent).toHaveBeenCalledWith('updated-cohort-history', 8);
    });
    expect(syncDbFrame.mock.calls.map(([frameId]) => frameId)).toEqual([3, 6]);
  });

  it.each([
    {
      name: 'captured with the winning bid',
      capturedPrice: 2_000_000n,
      historicalPrices: [],
      expectedPrice: 2_000_000n,
      expectedHistoricalReads: 0,
    },
    {
      name: 'from the bidding frame for a legacy bid file',
      capturedPrice: undefined,
      historicalPrices: [
        { id: 9, microgonToArgonot: [3_000_000n] },
        { id: 10, microgonToArgonot: [] },
        { id: 11, microgonToArgonot: [0n] },
        { id: 12, microgonToArgonot: [8_000_000n, 9_000_000n] },
      ],
      expectedPrice: 3_000_000n,
      expectedHistoricalReads: 1,
    },
  ])('persists the argonot price $name', async testCase => {
    const { syncer } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const insertOrUpdate = vi.fn();
    const fetchArgonotPricesNearFrame = vi.fn().mockResolvedValue(testCase.historicalPrices);
    (syncer as any).db = {
      cohortsTable: { insertOrUpdate },
      framesTable: { fetchArgonotPricesNearFrame },
    };
    (syncer as any).miningFrames = {
      waitForFrameId: vi.fn().mockResolvedValue(undefined),
      getTickStart: vi.fn().mockReturnValue(1_000),
    };
    (syncer as any).mainchain = {
      minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(1_000_000n),
    };
    vi.spyOn(syncer as any, 'fetchBidsFileFromCache').mockResolvedValue({
      biddingFrameRewardTicksRemaining: 0,
      allMinersCount: 10,
      microgonsToBeMinedPerBlock: 1_000n,
      transactionFeesByBlock: {},
      seatCountWon: 2,
      microgonsBidTotal: 6_000_000n,
      micronotsStakedPerSeat: 1_000_000n,
      argonotPriceAtBid: testCase.capturedPrice,
      winningBids: [
        { subAccountIndex: 0, microgonsPerSeat: 1_000_000n },
        { subAccountIndex: 1, microgonsPerSeat: 5_000_000n },
      ],
    });

    await testSyncer.syncDbCohort(12);

    const cohort = insertOrUpdate.mock.calls[0][0];
    expect(cohort).toEqual(
      expect.objectContaining({
        argonotPriceAtBid: testCase.expectedPrice,
        microgonsBidPerSeat: 3_000_000n,
      }),
    );
    expect(fetchArgonotPricesNearFrame).toHaveBeenCalledTimes(testCase.expectedHistoricalReads);
  });
});

function createSyncer(options: { gatewayReady?: boolean } = {}) {
  const botFns: IBotFns = {
    onEvent: vi.fn(),
    setStatus: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setBotState: vi.fn(),
  };
  const installer = {
    isLoadedPromise: Promise.resolve(),
    refreshLocalGatewayPort: vi.fn(),
  };
  const serverApiClient = {
    isGatewayReady: vi.fn().mockResolvedValue(options.gatewayReady ?? true),
  };
  const config = { isServerInstalled: true, latestFrameIdProcessed: 1 };
  const framesTable = {
    fetchLastProcessedFrame: vi.fn().mockResolvedValue(1),
    fetchProcessedFrameIdsSince: vi.fn<() => Promise<number[]>>().mockResolvedValue([]),
  };
  const cohortsTable = {
    fetchCohortIdsSince: vi.fn<() => Promise<number[]>>().mockResolvedValue([]),
  };

  const syncer = new BotSyncer(
    config as any,
    { framesTable, cohortsTable } as any,
    installer as any,
    serverApiClient as any,
    { load: vi.fn() } as any,
    {} as any,
    botFns,
  );

  return { syncer, botFns, installer, serverApiClient, config, framesTable, cohortsTable };
}
