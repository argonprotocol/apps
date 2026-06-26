import './helpers/mocks.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot } from '../lib/Bot.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';

describe('Bot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists downloaded bidding rules through the dedicated config save path', async () => {
    const remoteRules = {
      seatGoal: {
        type: 'static',
        seats: 1,
      },
    };
    vi.spyOn(ServerAdmin.prototype, 'downloadConfigState').mockResolvedValue({
      biddingRules: remoteRules as any,
      oldestFrameIdToSync: 42,
      ethereumBeaconApiUrl: 'https://beacon.example',
      ethereumExecutionRpcUrl: 'https://execution.example',
    });
    const config = createConfigStub();
    const bot = new Bot(config as any, Promise.resolve({} as any), {} as any);

    await bot.loadServerConfig();

    expect(config.biddingRules).toEqual(remoteRules);
    expect(config.oldestFrameIdToSync).toBe(42);
    expect(config.ethereumBeaconApiUrl).toBe('https://beacon.example');
    expect(config.ethereumExecutionRpcUrl).toBe('https://execution.example');
    expect(config.saveBiddingRules).toHaveBeenCalledTimes(1);
    expect(config.save).not.toHaveBeenCalled();
  });

  it('preserves local config when the server omits optional env state fields', async () => {
    vi.spyOn(ServerAdmin.prototype, 'downloadConfigState').mockResolvedValue({
      biddingRules: undefined,
      oldestFrameIdToSync: undefined,
      ethereumBeaconApiUrl: undefined,
      ethereumExecutionRpcUrl: undefined,
    });
    const config = createConfigStub({
      oldestFrameIdToSync: 88,
      ethereumBeaconApiUrl: 'https://local-beacon.example',
      ethereumExecutionRpcUrl: 'https://local-execution.example',
    });
    const bot = new Bot(config as any, Promise.resolve({} as any), {} as any);

    await bot.loadServerConfig();

    expect(config.oldestFrameIdToSync).toBe(88);
    expect(config.ethereumBeaconApiUrl).toBe('https://local-beacon.example');
    expect(config.ethereumExecutionRpcUrl).toBe('https://local-execution.example');
    expect(config.saveBiddingRules).not.toHaveBeenCalled();
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it('applies an explicitly empty beacon api url from server state', async () => {
    vi.spyOn(ServerAdmin.prototype, 'downloadConfigState').mockResolvedValue({
      biddingRules: undefined,
      oldestFrameIdToSync: undefined,
      ethereumBeaconApiUrl: '',
      ethereumExecutionRpcUrl: undefined,
    });
    const config = createConfigStub({
      ethereumBeaconApiUrl: 'https://local-beacon.example',
    });
    const bot = new Bot(config as any, Promise.resolve({} as any), {} as any);

    await bot.loadServerConfig();

    expect(config.ethereumBeaconApiUrl).toBe('');
    expect(config.save).toHaveBeenCalledTimes(1);
  });
});

function createConfigStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    miningSetupStatus: MiningSetupStatus.Finished,
    serverDetails: {
      ipAddress: '127.0.0.1',
      sshUser: 'root',
      workDir: '~',
    },
    biddingRules: {
      seatGoal: {
        type: 'static',
        seats: 2,
      },
    },
    oldestFrameIdToSync: 12,
    ethereumBeaconApiUrl: 'https://default-beacon.example',
    ethereumExecutionRpcUrl: 'https://default-execution.example',
    saveBiddingRules: vi.fn(),
    save: vi.fn(),
    ...overrides,
  };
}
