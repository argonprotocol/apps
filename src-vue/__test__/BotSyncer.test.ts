import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IBotState } from '@argonprotocol/apps-core';
import { BotWsClient } from '../lib/BotWsClient.ts';
import { BotStatus, BotSyncer, type IBotFns } from '../lib/BotSyncer.ts';

type IBotSyncerTestTarget = {
  runSync(state: { isReady: boolean; isSyncing: boolean; serverError: string; currentFrameId?: number }): Promise<void>;
  fetchCohort(
    cohortActivationFrameId: number,
  ): Promise<Parameters<import('../lib/db/CohortsTable.ts').CohortsTable['insertOrUpdate']>[0]>;
  updateBotState(state: { currentFrameId: number }): Promise<void>;
  syncServerState(state: { currentFrameId: number }): Promise<void>;
  syncCurrentBids(state: IBotState): Promise<void>;
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

  it('publishes one current mining snapshot before reporting ready', async () => {
    const { syncer, botFns } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const state = {
      isReady: true,
      isSyncing: false,
      serverError: '',
      currentFrameId: 424,
      winningBids: [{ address: 'winning-account' }],
    };
    vi.spyOn(testSyncer, 'updateBotState').mockResolvedValue(undefined);
    vi.spyOn(testSyncer, 'syncServerState').mockResolvedValue(undefined);
    const syncCurrentBids = vi.spyOn(testSyncer, 'syncCurrentBids').mockImplementation(async currentState => {
      expect(currentState).toBe(state);
      expect(botFns.setBotState).not.toHaveBeenCalled();
    });

    await testSyncer.runSync(state);

    expect(syncCurrentBids).toHaveBeenCalledWith(state);
    expect(botFns.setBotState).toHaveBeenCalledWith(state);
    const onEvent = vi.mocked(botFns.onEvent);
    const setBotState = vi.mocked(botFns.setBotState);
    const miningStateEvent = onEvent.mock.calls.findIndex(([event]) => event === 'updated-mining-state');
    expect(miningStateEvent).toBeGreaterThanOrEqual(0);
    expect(setBotState.mock.invocationCallOrder[0]).toBeLessThan(onEvent.mock.invocationCallOrder[miningStateEvent]);
    expect(botFns.onEvent).toHaveBeenCalledWith('updated-mining-state', 424);
    expect(botFns.onEvent).not.toHaveBeenCalledWith('updated-bids-data', expect.anything());
    expect(botFns.onEvent).not.toHaveBeenCalledWith('updated-cohort-data', expect.anything());
    expect(onEvent.mock.invocationCallOrder[miningStateEvent]).toBeLessThan(
      vi.mocked(botFns.setStatus).mock.invocationCallOrder.at(-1)!,
    );
    expect(botFns.setStatus).toHaveBeenLastCalledWith(BotStatus.Ready);
  });

  it('keeps current bids and readiness during server history recovery', async () => {
    const { syncer, botFns, frameBidsTable } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    vi.spyOn(testSyncer, 'syncServerState').mockResolvedValue(undefined);
    const state = {
      isReady: true,
      isSyncing: true,
      serverError: '',
      currentFrameId: 424,
      oldestFrameIdToSync: 1,
      hasMiningSeats: true,
      hasMiningBids: true,
      botLastActiveBlockNumber: 901,
      currentAuctionMicronotsPerSeat: 17n,
      winningBids: [{ address: '5AlreadyWinning', subAccountIndex: 2, microgonsPerSeat: 42n }],
    };

    await testSyncer.runSync(state);

    expect(frameBidsTable.insertOrUpdate).toHaveBeenCalledWith(424, 901, [
      expect.objectContaining({
        address: '5AlreadyWinning',
        subAccountIndex: 2,
        microgonsPerSeat: 42n,
        micronotsStakedPerSeat: 17n,
      }),
    ]);
    expect(botFns.setBotState).toHaveBeenCalledWith(state);
    expect(botFns.setStatus).toHaveBeenLastCalledWith(BotStatus.Ready);
    expect(botFns.setStatus).not.toHaveBeenCalledWith(BotStatus.ServerSyncing);
    expect(botFns.setStatus).not.toHaveBeenCalledWith(BotStatus.DbSyncing);
    expect(botFns.onEvent).toHaveBeenCalledWith('updated-current-bids', 424);
    expect(botFns.onEvent).not.toHaveBeenCalledWith('updated-mining-state', 424);
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
  ])('selects the argonot price $name', async testCase => {
    const { syncer } = createSyncer();
    const testSyncer = syncer as unknown as IBotSyncerTestTarget;
    const fetchArgonotPricesNearFrame = vi.fn().mockResolvedValue(testCase.historicalPrices);
    (syncer as any).db = {
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
    });

    const cohort = await testSyncer.fetchCohort(12);
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
    setDbHistoryError: vi.fn(),
    setBotState: vi.fn(),
  };
  const installer = {
    isLoadedPromise: Promise.resolve(),
    refreshLocalGatewayPort: vi.fn(),
  };
  const serverApiClient = {
    isGatewayReady: vi.fn().mockResolvedValue(options.gatewayReady ?? true),
  };
  const config = { isServerInstalled: true, latestFrameIdProcessed: 1, save: vi.fn() };
  const framesTable = {
    fetchLastProcessedFrame: vi.fn().mockResolvedValue(1),
    fetchProcessedFrameIdsSince: vi.fn<() => Promise<number[]>>().mockResolvedValue([]),
  };
  const cohortsTable = {
    fetchCohortIdsSince: vi.fn<() => Promise<number[]>>().mockResolvedValue([]),
  };
  const frameBidsTable = {
    insertOrUpdate: vi.fn(),
  };

  const syncer = new BotSyncer(
    config as any,
    { framesTable, cohortsTable, frameBidsTable } as any,
    installer as any,
    serverApiClient as any,
    { load: vi.fn() } as any,
    {} as any,
    botFns,
  );

  return { syncer, botFns, installer, frameBidsTable };
}
