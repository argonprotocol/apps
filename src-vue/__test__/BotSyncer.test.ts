import { describe, expect, it, vi } from 'vitest';
import { BotStatus, BotSyncer, type IBotFns } from '../lib/BotSyncer.ts';

type IBotSyncerTestTarget = {
  runSync(state: { isReady: boolean; isSyncing: boolean; serverError: string; currentFrameId?: number }): Promise<void>;
  updateBotState(state: { currentFrameId: number }): Promise<void>;
};

vi.mock('../stores/mainchain', () => ({
  getMining: vi.fn(() => ({})),
}));

describe('BotSyncer', () => {
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

function createSyncer() {
  const botFns: IBotFns = {
    onEvent: vi.fn(),
    setStatus: vi.fn(),
    setServerSyncProgress: vi.fn(),
    setDbSyncProgress: vi.fn(),
    setBotState: vi.fn(),
  };

  const syncer = new BotSyncer(
    { isServerInstalled: true } as any,
    {} as any,
    { isLoadedPromise: Promise.resolve() } as any,
    { load: vi.fn() } as any,
    botFns,
  );

  return { syncer, botFns };
}
