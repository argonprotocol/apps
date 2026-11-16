import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, MiningFrames, NetworkConfig } from '../src/index.ts';
import type { IBlockHeaderInfo } from '../src/BlockWatch.ts';

describe('MiningFrames frame refresh recovery', () => {
  afterEach(() => {
    NetworkConfig.clearRuntimeOverride('dev-docker');
    vi.restoreAllMocks();
  });

  it('repairs the saved frame at startup and reads history only when the frame changes', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = {
      ...createHeaderInfo(182, '0xlatest', '0x181', 18, 1_820),
      isNewFrame: false,
      frameRewardTicksRemaining: 10,
    };
    let frameHeader = createHeaderInfo(181, '0xframe', '0x180', 18, 1_810);
    const frameApi = {
      query: { miningSlot: { frameStartBlockNumbers: vi.fn().mockResolvedValue([181]) } },
      runtimeVersion: { specVersion: createNumberLike(153) },
    };
    const getApi = vi.fn().mockResolvedValue(frameApi);
    const blockWatch = {
      latestHeaders: [latestHeader],
      start: vi.fn(),
      getApi,
      getHeader: vi.fn(async (_blockNumber: number) => frameHeader),
      events: { on: vi.fn().mockReturnValue(vi.fn()) },
    };
    const updatesWriter = {
      read: async () =>
        JSON.stringify([
          {
            frameId: 18,
            frameStartTick: 1_800,
            dateStart: new Date(1_800_000),
            firstBlockNumber: 181,
            firstBlockHash: '0xstale',
            firstBlockTick: 1_800,
            firstBlockSpecVersion: 152,
          },
        ]),
      write: vi.fn(),
    };
    const miningFrames = new MiningFrames(
      createClientsWithGenesis('0xgenesis') as any,
      blockWatch as any,
      updatesWriter,
    );
    await miningFrames.load();

    expect(getApi).toHaveBeenNthCalledWith(1, latestHeader);
    expect(getApi).toHaveBeenNthCalledWith(2, frameHeader);
    expect(miningFrames.framesById[18]).toMatchObject({
      firstBlockNumber: 181,
      firstBlockHash: '0xframe',
      firstBlockTick: 1_810,
      firstBlockSpecVersion: 153,
    });

    const ordinaryHeader = {
      ...latestHeader,
      blockNumber: 183,
      blockHash: '0xordinary',
      parentHash: latestHeader.blockHash,
      tick: 1_830,
    };
    const startupApiReads = getApi.mock.calls.length;
    await miningFrames['onBestBlocks']([ordinaryHeader]);
    expect(getApi).toHaveBeenCalledTimes(startupApiReads);
    expect(blockWatch.getHeader).toHaveBeenCalledOnce();
    expect(miningFrames.currentTick).toBe(1_830);

    frameHeader = { ...frameHeader, blockHash: '0xreplacement', tick: 1_812, isNewFrame: true };
    getApi.mockRejectedValueOnce(new Error('The frame snapshot is temporarily unavailable'));
    await miningFrames['onBestBlocks']([frameHeader]);
    expect(miningFrames.framesById[18].firstBlockHash).toBe('0xframe');
    await miningFrames['onBestBlocks']([{ ...ordinaryHeader, blockNumber: 184, blockHash: '0xreplacement-tip' }]);
    expect(miningFrames.framesById[18]).toMatchObject({ firstBlockHash: '0xreplacement', firstBlockTick: 1_812 });
    frameHeader = { ...frameHeader, blockHash: '0xresumed-frame', tick: 1_814 };
    await miningFrames['onBestBlocks']([{ ...ordinaryHeader, blockNumber: 184, blockHash: '0xresumed-tip' }]);
    expect(miningFrames.framesById[18]).toMatchObject({ firstBlockHash: '0xresumed-frame', firstBlockTick: 1_814 });
    let newerStart = { ...createHeaderInfo(191, '0xoriginal-19', '0x190', 19, 1_910), isNewFrame: true };
    frameApi.query.miningSlot.frameStartBlockNumbers.mockResolvedValue([191, 181]);
    blockWatch.getHeader.mockImplementation(async blockNumber => (blockNumber === 191 ? newerStart : frameHeader));
    await miningFrames['onBestBlocks']([newerStart]);
    expect(miningFrames.currentFrameId).toBe(19);
    expect(miningFrames.framesById[19].firstBlockHash).toBe('0xoriginal-19');

    frameHeader = { ...frameHeader, blockHash: '0xfork-18', tick: 1_816 };
    newerStart = { ...newerStart, blockHash: '0xfork-19' };
    await miningFrames['onBestBlocks']([
      frameHeader,
      newerStart,
      { ...newerStart, blockNumber: 192, blockHash: '0xfork-tip', parentHash: newerStart.blockHash, isNewFrame: false },
    ]);
    expect(miningFrames.framesById[18]).toMatchObject({ firstBlockHash: '0xfork-18', firstBlockTick: 1_816 });
    expect(miningFrames.framesById[19]).toMatchObject({ firstBlockHash: '0xfork-19', firstBlockTick: 1_910 });
    await miningFrames.stop();
  });

  it('refreshes and retries a stale persisted frame behind a valid newer frame', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(192, '0xlatest', '0x191', 19, 1_920);
    const newerFrameHeader = createHeaderInfo(191, '0xnewer-frame', '0x190', 19, 1_910);
    const frameHeader = createHeaderInfo(181, '0xframe', '0x180', 18, 1_810);
    const unreadableError = new Error('Unable to retrieve header and parent from supplied hash');
    const currentApi = {
      query: {
        miningSlot: {
          frameStartBlockNumbers: vi.fn().mockResolvedValue([191, 181]),
        },
      },
    };
    const frameApi = {
      query: {
        miningSlot: {
          frameStartBlockNumbers: vi.fn().mockResolvedValue([181]),
        },
      },
      runtimeVersion: {
        specVersion: createNumberLike(153),
      },
    };
    const pendingFrameApi = createDeferred<typeof frameApi>();
    let frameApiCalls = 0;
    const getApi = vi.fn(async ({ blockHash }: IBlockHeaderInfo) => {
      if (blockHash === '0xstale') throw unreadableError;
      if (blockHash === latestHeader.blockHash) return currentApi;
      if (blockHash === newerFrameHeader.blockHash) return frameApi;
      if (blockHash === frameHeader.blockHash) {
        frameApiCalls += 1;
        return frameApiCalls === 1 ? frameApi : await pendingFrameApi.promise;
      }
      throw new Error(`Unexpected block hash ${blockHash}`);
    });
    const blockWatch = {
      latestHeaders: [latestHeader],
      getApi,
      getHeader: vi.fn(async (blockNumber: number) => {
        if (blockNumber === newerFrameHeader.blockNumber) return newerFrameHeader;
        if (blockNumber === frameHeader.blockNumber) return frameHeader;
        throw new Error(`Unexpected block number ${blockNumber}`);
      }),
      events: { on: vi.fn() },
    };
    const miningFrames = new MiningFrames({} as any, blockWatch as any);
    miningFrames.framesById[18] = {
      frameId: 18,
      frameStartTick: 1_800,
      dateStart: new Date(1_800_000),
      firstBlockNumber: 21_101,
      firstBlockHash: '0xstale',
      firstBlockTick: 1_800,
      firstBlockSpecVersion: 152,
    };
    miningFrames.framesById[19] = {
      frameId: 19,
      frameStartTick: 1_910,
      dateStart: new Date(1_910_000),
      firstBlockNumber: 191,
      firstBlockHash: '0xnewer-frame',
      firstBlockTick: 1_910,
      firstBlockSpecVersion: 153,
    };

    const frameStartPromise = miningFrames.getFrameStart(18);
    await vi.waitFor(() => expect(frameApiCalls).toBe(2));

    Object.assign(miningFrames.framesById[18], {
      firstBlockNumber: 182,
      firstBlockHash: '0xnext-frame',
    });
    pendingFrameApi.resolve(frameApi);
    const frameStart = await frameStartPromise;

    expect(frameStart.api).toBe(frameApi);
    expect(frameStart.frame).toMatchObject({
      firstBlockNumber: 181,
      firstBlockHash: '0xframe',
      firstBlockTick: 1_810,
      firstBlockSpecVersion: 153,
    });
  });

  it('does not reject higher callers when frame refresh hits a retryable API miss', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(182, '0xlatest', '0x181', 18, 1_820);
    const frameHeader = createHeaderInfo(181, '0xframe', '0x180', 18, 1_810);
    const currentApi = {
      query: {
        miningSlot: {
          frameStartBlockNumbers: vi.fn().mockResolvedValue([181]),
        },
      },
    };
    const blockWatch = {
      getApi: vi
        .fn()
        .mockResolvedValueOnce(currentApi)
        .mockRejectedValueOnce(new Error('Unable to retrieve header and parent from supplied hash')),
      getHeader: vi.fn().mockResolvedValue(frameHeader),
      events: { on: vi.fn() },
    };
    const miningFrames = new MiningFrames({} as any, blockWatch as any);
    const checkForFrameChange = getCheckForFrameChange(miningFrames);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(checkForFrameChange.call(miningFrames, [latestHeader])).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      '[Mining Frames] Failed to refresh frame history, will retry on the next block',
      expect.any(Error),
    );
    expect(miningFrames.framesById[18]).toBeUndefined();
  });

  it('retries load after an initial bootstrap failure and cleans up the temporary subscription', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(0, '0xgenesis', '0xparent', 0, 0);
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    const blockWatch = {
      latestHeaders: [latestHeader],
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      isLoaded: { isRejected: false },
      events: {
        on: vi.fn().mockReturnValueOnce(unsubscribeFirst).mockReturnValueOnce(unsubscribeSecond),
      },
    };
    const clients = createClientsWithGenesis('0xgenesis');
    const miningFrames = new MiningFrames(clients as any, blockWatch as any);
    const onBestBlocks = vi
      .spyOn(miningFrames as any, 'onBestBlocks')
      .mockRejectedValueOnce(new Error('bootstrap failed'))
      .mockResolvedValueOnce(undefined);

    await expect(miningFrames.load()).rejects.toThrow('bootstrap failed');
    await expect(miningFrames.load()).resolves.toBeUndefined();

    expect(blockWatch.events.on).toHaveBeenCalledTimes(2);
    expect(unsubscribeFirst).toHaveBeenCalledOnce();
    expect(unsubscribeSecond).not.toHaveBeenCalled();
    expect(onBestBlocks).toHaveBeenCalledTimes(2);
  });

  it('retries load after a failed startup', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = {
      ...createHeaderInfo(0, '0xgenesis', '0xparent', 0, 0),
      frameRewardTicksRemaining: 12,
    };
    const blockWatch = {
      latestHeaders: [latestHeader],
      start: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined),
      events: { on: vi.fn().mockReturnValue(vi.fn()) },
    };
    const clients = createClientsWithGenesis('0xgenesis');
    const miningFrames = new MiningFrames(clients as any, blockWatch as any);

    await expect(miningFrames.load()).rejects.toThrow('offline');
    await expect(miningFrames.load()).resolves.toBeUndefined();

    expect(blockWatch.start).toHaveBeenCalledTimes(2);
    expect(miningFrames.currentFrameRewardTicksRemaining).toBe(12);
  });
});

function createHeaderInfo(
  blockNumber: number,
  blockHash: string,
  parentHash: string,
  frameId?: number,
  tick = blockNumber,
): IBlockHeaderInfo {
  return {
    isFinalized: blockNumber <= 100,
    blockNumber,
    blockHash,
    blockTime: blockNumber * 1_000,
    parentHash,
    author: 'author',
    tick,
    frameId,
    frameRewardTicksRemaining: 10,
  };
}

function createNumberLike(value: number) {
  return {
    toNumber: () => value,
  };
}

function createClientsWithGenesis(genesisHash: string) {
  return {
    prunedClientOrArchivePromise: Promise.resolve({
      genesisHash: { toHex: () => genesisHash },
      runtimeVersion: {
        specVersion: createNumberLike(153),
      },
    }),
  };
}

function getCheckForFrameChange(miningFrames: MiningFrames): (headers: IBlockHeaderInfo[]) => Promise<void> {
  return Reflect.get(miningFrames, 'checkForFrameChange') as (headers: IBlockHeaderInfo[]) => Promise<void>;
}
