import './helpers/mocks.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot, botEmitter } from '../lib/Bot.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';
import { SSH } from '../lib/SSH.ts';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';
import { FinancialCacheTypes, MiningSummaryCacheScope } from '../lib/db/FinancialCacheTable.ts';
import { createDeferred, type IDeferred, type IMiningSummary } from '@argonprotocol/apps-core';

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

  it('refreshes the mining summary only when its server revision changes', async () => {
    const stateWithMiningActivity = {
      ...readyState,
      hasMiningSeats: true,
      hasMiningBids: true,
      oldestFrameIdToSync: 1,
    };
    const stateWithoutMiningActivity = {
      ...stateWithMiningActivity,
      hasMiningSeats: false,
      hasMiningBids: false,
    };
    const states = [stateWithMiningActivity, stateWithoutMiningActivity];
    const fetch = vi.fn(async method => (method === '/state' ? states.shift() : miningSummary));
    const upsertSummary = vi.fn();
    const db = {
      financialCacheTable: { upsert: upsertSummary },
      syncStateTable: {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    const config = createConfigStub({ hasMiningSeats: false, hasMiningBids: false });
    const bot = new Bot(config as any, Promise.resolve(db as any), {} as any);
    Reflect.set(bot, 'db', db);
    Reflect.set(bot, 'client', { connectDeferred: { promise: Promise.resolve() }, fetch });
    Reflect.set(bot, 'miningFrames', { blockWatch: { getBlockTime: vi.fn().mockResolvedValue(new Date()) } });
    const loadDeferred = Reflect.get(bot, 'loadDeferred') as IDeferred<void>;
    loadDeferred.resolve();
    const summaries: IMiningSummary[] = [];
    const onSummary = (value: IMiningSummary) => summaries.push(value);
    botEmitter.on('updated-mining-summary', onSummary);

    try {
      await bot.refreshState();
      await bot.refreshState();
    } finally {
      botEmitter.off('updated-mining-summary', onSummary);
    }

    expect(bot.isReady).toBe(true);
    expect(bot.state).toBe(stateWithoutMiningActivity);
    expect(config.hasMiningSeats).toBe(true);
    expect(config.hasMiningBids).toBe(true);
    expect(fetch.mock.calls.filter(([method]) => method === '/mining-summary')).toHaveLength(1);
    expect(upsertSummary).toHaveBeenCalledWith(
      FinancialCacheTypes.MiningSummary,
      MiningSummaryCacheScope,
      miningSummary,
    );
    expect(summaries).toEqual([miningSummary]);
  });

  it('stays syncing when a ready state arrives during a bidding rules upload', async () => {
    vi.useFakeTimers();
    const upload = createDeferred<void>();
    vi.spyOn(SSH, 'getOrCreateConnection').mockResolvedValue({} as any);
    vi.spyOn(ServerAdmin.prototype, 'uploadBiddingRules').mockReturnValue(upload.promise);
    const db = {
      financialCacheTable: { upsert: vi.fn() },
      syncStateTable: {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    const config = createConfigStub();
    const bot = new Bot(config as any, Promise.resolve(db as any), {} as any);
    Reflect.set(bot, 'db', db);
    Reflect.set(bot, 'client', {
      connectDeferred: { promise: Promise.resolve() },
      fetch: vi.fn(async method => (method === '/state' ? readyState : miningSummary)),
    });
    Reflect.set(bot, 'miningFrames', { blockWatch: { getBlockTime: vi.fn().mockResolvedValue(new Date()) } });
    const loadDeferred = Reflect.get(bot, 'loadDeferred') as IDeferred<void>;
    loadDeferred.resolve();

    const resyncPromise = bot.resyncBiddingRules();
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(bot.isSyncing).toBe(true);

      await bot.refreshState();

      expect(bot.isSyncing).toBe(true);
    } finally {
      upload.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await resyncPromise;
      vi.useRealTimers();
    }

    expect(bot.isReady).toBe(true);
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
    hasMiningSeats: false,
    hasMiningBids: false,
    ethereumBeaconApiUrl: 'https://default-beacon.example',
    ethereumExecutionRpcUrl: 'https://default-execution.example',
    saveBiddingRules: vi.fn(),
    save: vi.fn(),
    ...overrides,
  };
}

const miningSummary: IMiningSummary = {
  observedAt: new Date('2026-07-28T12:00:00Z'),
  sourceBlockNumber: 456,
  latestFrameId: 12,
  cohorts: [],
  frames: [],
  currentBids: [],
  global: {
    seatsTotal: 0,
    framesCompleted: 0,
    framesRemaining: 0,
    framedCost: 0n,
    transactionFeesTotal: 0n,
    microgonsBidTotal: 0n,
    micronotsMinedTotal: 0n,
    microgonsMinedTotal: 0n,
    microgonsMintedTotal: 0n,
  },
};

const readyState = {
  isReady: true,
  isSyncing: false,
  serverError: '',
  currentFrameId: 12,
  oldestFrameIdToSync: 12,
  hasMiningSeats: false,
  hasMiningBids: false,
  earningsLastModifiedAt: new Date('2026-07-28T11:59:00Z'),
  bidsLastModifiedAt: new Date('2026-07-28T11:58:00Z'),
  botLastActiveDate: new Date('2026-07-28T11:57:00Z'),
  botLastActiveBlockNumber: 450,
  argonBlockNumbers: { localNode: 456, mainNode: 456 },
  bitcoinBlockNumbers: { localNode: 100, mainNode: 100, localNodeBlockTime: 1_753_700_000 },
};
