import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockWatch, type IBlockHeaderInfo } from '../src/BlockWatch.ts';

describe('BlockWatch archive recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries parent header lookup on archive when pruned state was discarded', async () => {
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    const parentHeader = createHeaderInfo(109, '0xparent', '0xgrandparent');
    const prunedClient = {
      rpc: {
        chain: {
          getHeader: vi.fn().mockRejectedValue(new Error('4003: State already discarded for 0xparent')),
        },
      },
    };
    const archiveClient = {
      rpc: {
        chain: {
          getHeader: vi.fn().mockResolvedValue({ __info: parentHeader }),
        },
      },
    };
    const blockWatch = new BlockWatch({
      prunedClientPromise: Promise.resolve(prunedClient),
      archiveClientPromise: Promise.resolve(archiveClient),
    } as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    (blockWatch as any).isPrunedClientSubscription = true;

    const result = await blockWatch.getParentHeader(createHeaderInfo(110, '0xchild', '0xparent'));

    expect(prunedClient.rpc.chain.getHeader).toHaveBeenCalledWith('0xparent');
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0xparent');
    expect(result).toBe(parentHeader);
  });

  it('retries historical header lookup on archive when block hash resolution fails on pruned', async () => {
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    const historicalHeader = createHeaderInfo(108, '0x108', '0x107');
    const prunedClient = {
      rpc: {
        chain: {
          getBlockHash: vi.fn().mockRejectedValue(new Error('4003: Api called for an unknown Block')),
          getHeader: vi.fn(),
        },
      },
    };
    const archiveClient = {
      rpc: {
        chain: {
          getBlockHash: vi.fn().mockResolvedValue('0x108'),
          getHeader: vi.fn().mockResolvedValue({ __info: historicalHeader }),
        },
      },
    };
    const blockWatch = new BlockWatch({
      prunedClientPromise: Promise.resolve(prunedClient),
      archiveClientPromise: Promise.resolve(archiveClient),
    } as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    (blockWatch as any).isPrunedClientSubscription = true;

    const result = await blockWatch.getHeader(108);

    expect(prunedClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
    expect(archiveClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0x108');
    expect(result).toBe(historicalHeader);
  });
});

function createHeaderInfo(blockNumber: number, blockHash: string, parentHash: string): IBlockHeaderInfo {
  return {
    isFinalized: false,
    blockNumber,
    blockHash,
    blockTime: blockNumber * 1_000,
    parentHash,
    author: 'author',
    tick: blockNumber,
  };
}

function readMockHeader(header: unknown): IBlockHeaderInfo {
  return (header as { __info: IBlockHeaderInfo }).__info;
}
