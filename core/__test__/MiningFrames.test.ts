import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiningFrames, NetworkConfig } from '../src/index.ts';
import type { IBlockHeaderInfo } from '../src/BlockWatch.ts';

describe('MiningFrames frame refresh recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses cached block APIs for latest and historical frame reads', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(182, '0xlatest', '0x181', undefined, 1_820);
    const frameHeader = createHeaderInfo(181, '0xframe', '0x180', 18, 1_810);
    const currentApi = {
      query: {
        miningSlot: {
          frameStartBlockNumbers: vi.fn().mockResolvedValue([createNumberLike(181)]),
        },
      },
    };
    const frameApi = {
      query: {
        miningSlot: {
          nextFrameId: vi.fn().mockResolvedValue(createNumberLike(19)),
          frameStartBlockNumbers: vi.fn().mockResolvedValue([createNumberLike(181)]),
        },
      },
      runtimeVersion: {
        specVersion: createNumberLike(153),
      },
    };
    const getApi = vi.fn().mockResolvedValueOnce(currentApi).mockResolvedValueOnce(frameApi);
    const blockWatch = {
      getApi,
      getHeader: vi.fn().mockResolvedValue(frameHeader),
      events: { on: vi.fn() },
    };
    const clients = {};
    Object.defineProperty(clients, 'prunedClientOrArchivePromise', {
      get() {
        throw new Error('should use BlockWatch.getApi instead');
      },
    });

    const miningFrames = new MiningFrames(clients as any, blockWatch as any);
    const checkForFrameChange = getCheckForFrameChange(miningFrames);

    await checkForFrameChange.call(miningFrames, [latestHeader]);

    expect(getApi).toHaveBeenNthCalledWith(1, latestHeader);
    expect(getApi).toHaveBeenNthCalledWith(2, frameHeader);
    expect(miningFrames.framesById[18]).toMatchObject({
      frameId: 18,
      firstBlockNumber: 181,
      firstBlockHash: '0xframe',
      firstBlockTick: 1_810,
      firstBlockSpecVersion: 153,
    });
  });

  it('does not reject higher callers when frame refresh hits a retryable API miss', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(182, '0xlatest', '0x181', undefined, 1_820);
    const frameHeader = createHeaderInfo(181, '0xframe', '0x180', 18, 1_810);
    const currentApi = {
      query: {
        miningSlot: {
          frameStartBlockNumbers: vi.fn().mockResolvedValue([createNumberLike(181)]),
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
  };
}

function createNumberLike(value: number) {
  return {
    toNumber: () => value,
  };
}

function getCheckForFrameChange(miningFrames: MiningFrames): (headers: IBlockHeaderInfo[]) => Promise<void> {
  return Reflect.get(miningFrames, 'checkForFrameChange') as (headers: IBlockHeaderInfo[]) => Promise<void>;
}
