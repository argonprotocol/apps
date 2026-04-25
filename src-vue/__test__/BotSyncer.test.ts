import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotWsClient } from '../lib/BotWsClient.ts';
import { BotStatus, BotSyncer, type IBotFns } from '../lib/BotSyncer.ts';

type IBotSyncerTestTarget = {
  runSync(state: { isReady: boolean; isSyncing: boolean; serverError: string; currentFrameId?: number }): Promise<void>;
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

  const syncer = new BotSyncer(
    { isServerInstalled: true } as any,
    {} as any,
    installer as any,
    serverApiClient as any,
    { load: vi.fn() } as any,
    {} as any,
    botFns,
  );

  return { syncer, botFns, installer, serverApiClient };
}
