import { expect, it, vi } from 'vitest';
import { WalletRecovery } from '../lib/WalletRecovery.ts';
import { findAddressActivity } from '../lib/IndexerClient.ts';

vi.mock('../lib/IndexerClient.ts', () => ({ findAddressActivity: vi.fn() }));

it('scans mining history during restore when the mining wallet is currently empty', async () => {
  const miningHistory = [
    {
      frameId: 20,
      bids: [{ bidPosition: 0, microgonsBid: 10n, micronotsStaked: 20n }],
      seats: [],
    },
  ];
  const walletsForArgon = {
    load: vi.fn().mockResolvedValue(undefined),
    defaultArgonWallet: { hasValue: () => false },
    miningBotWallet: { hasValue: () => false },
  };
  const recovery = new WalletRecovery(
    {} as any,
    {} as any,
    walletsForArgon as any,
    {} as any,
    { load: vi.fn().mockResolvedValue(undefined) } as any,
  );
  vi.spyOn(recovery as any, 'loadMiningHistory').mockResolvedValue(miningHistory);

  await expect(recovery.findHistory()).resolves.toEqual({ miningHistory, vaultingRules: undefined });
});

it('uses the full recovery range for mining when there is no vault history', async () => {
  const progress: number[] = [];
  const recovery = new WalletRecovery(
    {} as any,
    {} as any,
    {
      load: vi.fn().mockResolvedValue(undefined),
      defaultArgonWallet: { hasValue: () => false },
    } as any,
    { archiveClientPromise: Promise.resolve({}) } as any,
    { load: vi.fn().mockResolvedValue(undefined) } as any,
  );
  vi.spyOn(recovery as any, 'loadMiningHistory').mockImplementation(async (...args: unknown[]) => {
    const onProgress = args[1] as (progressPct: number) => void;
    onProgress(0);
    onProgress(20);
    onProgress(100);
    return undefined;
  });

  await recovery.findHistory(value => progress.push(value));

  expect(progress).toEqual([0, 3, 5, 10, 28, 100]);
  expect(progress).not.toContain(50);
});

it('combines mining and vault work without allowing progress to move backward', async () => {
  const progress: number[] = [];
  const recovery = new WalletRecovery(
    {
      load: vi.fn().mockResolvedValue(undefined),
      recoverAccountVault: vi.fn(async ({ onProgress }: { onProgress: (progressPct: number) => void }) => {
        onProgress(0);
        onProgress(50);
        onProgress(100);
        return undefined;
      }),
    } as any,
    {} as any,
    {
      load: vi.fn().mockResolvedValue(undefined),
      defaultArgonWallet: { hasValue: () => true },
    } as any,
    { archiveClientPromise: Promise.resolve({}) } as any,
    { load: vi.fn().mockResolvedValue(undefined) } as any,
  );
  vi.spyOn(recovery as any, 'loadMiningHistory').mockImplementation(async (...args: unknown[]) => {
    const onProgress = args[1] as (progressPct: number) => void;
    onProgress(0);
    onProgress(50);
    onProgress(100);
    return undefined;
  });

  await recovery.findHistory(value => progress.push(value));

  expect(progress.at(-1)).toBe(100);
  expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
});

it('counts epoch scans as work units and does not process below the recovery boundary', async () => {
  vi.mocked(findAddressActivity).mockResolvedValueOnce({
    blocks: [{ blockNumber: 123, activity: 0 }],
    coverage: { fromBlock: 0, toBlock: 123, gaps: [] },
  } as any);
  const getFrameStart = vi.fn(async (frameId: number) => ({
    frame: {
      firstBlockSpecVersion: 140,
      firstBlockNumber: frameId * 100,
      firstBlockHash: `0x${frameId}`,
      firstBlockTick: frameId * 10,
    },
    api: {
      query: {
        miningSlot: {
          minersByCohort: { entries: vi.fn().mockResolvedValue([]) },
        },
      },
    },
  }));
  const miningFrames = {
    currentFrameId: 30,
    framesById: {
      30: { firstBlockHash: '0x30' },
      20: { firstBlockHash: '0x20' },
      10: { firstBlockHash: '0x10' },
    },
    load: vi.fn().mockResolvedValue(undefined),
    getForBlock: vi.fn().mockResolvedValue(15),
    getFrameStart,
  };
  const recovery = new WalletRecovery(
    {} as any,
    {
      miningBotAddress: '5miner',
      getMiningBotSubaccounts: vi.fn().mockResolvedValue({}),
    } as any,
    {} as any,
    {} as any,
    miningFrames as any,
  );
  const progress: number[] = [];
  const liveClient = {
    query: {
      miningSlot: {
        bidsForNextSlotCohort: vi.fn().mockResolvedValue([]),
      },
    },
  };

  const loadMiningHistory = (
    recovery as unknown as {
      loadMiningHistory: (client: typeof liveClient, onProgress: (progressPct: number) => void) => Promise<unknown>;
    }
  ).loadMiningHistory.bind(recovery);
  await loadMiningHistory(liveClient, value => progress.push(value));

  expect(getFrameStart.mock.calls.map(([frameId]) => frameId)).toEqual([30, 20]);
  expect(progress).toEqual([0, 10, 15, 20, 60, 100, 100]);
  expect(progress.every(value => value >= 0 && value <= 100)).toBe(true);
});
