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
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

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
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

    const result = await blockWatch.getHeader(108);

    expect(prunedClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
    expect(archiveClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0x108');
    expect(result).toBe(historicalHeader);
  });

  it('retries historical header lookup on archive when the selected client query times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    try {
      const historicalHeader = createHeaderInfo(108, '0x108', '0x107');
      const prunedClient = {
        rpc: {
          chain: {
            getBlockHash: vi.fn().mockImplementation(() => new Promise(() => undefined)),
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
      const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
      blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
      getInternalBlockWatch(blockWatch).activeSource = 'pruned';

      const resultPromise = blockWatch.getHeaderByBlockNumber(108);
      await vi.advanceTimersByTimeAsync(120e3);

      await expect(resultPromise).resolves.toBe(historicalHeader);
      expect(prunedClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
      expect(archiveClient.rpc.chain.getBlockHash).toHaveBeenCalledWith(108);
      expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0x108');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries block api lookup on archive when pruned cannot decorate the supplied hash', async () => {
    const blockApi = { query: { system: { events: vi.fn() } } };
    const prunedClient = {
      at: vi.fn().mockRejectedValue(new Error('Unable to retrieve header and parent from supplied hash')),
    };
    const archiveClient = {
      at: vi.fn().mockResolvedValue(blockApi),
    };
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

    const result = await blockWatch.getApi(createHeaderInfo(110, '0xblock', '0xparent'));

    expect(prunedClient.at).toHaveBeenCalledWith('0xblock');
    expect(archiveClient.at).toHaveBeenCalledWith('0xblock');
    expect(result).toBe(blockApi);
  });

  it('retries signed block lookup on archive when the selected client disconnects', async () => {
    const signedBlock = { block: { extrinsics: [] } };
    const prunedClient = {
      rpc: {
        chain: {
          getBlock: vi.fn().mockRejectedValue(new Error('WebSocket is not connected')),
        },
      },
    };
    const archiveClient = {
      rpc: {
        chain: {
          getBlock: vi.fn().mockResolvedValue(signedBlock),
        },
      },
    };
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

    const result = await blockWatch.getBlock(createHeaderInfo(110, '0xblock', '0xparent'));

    expect(prunedClient.rpc.chain.getBlock).toHaveBeenCalledWith('0xblock');
    expect(archiveClient.rpc.chain.getBlock).toHaveBeenCalledWith('0xblock');
    expect(result).toBe(signedBlock);
  });

  it('retries header lookup on archive when the pruned websocket drops mid-query', async () => {
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    const parentHeader = createHeaderInfo(109, '0xparent', '0xgrandparent');
    const prunedClient = {
      rpc: {
        chain: {
          getHeader: vi.fn().mockRejectedValue(new Error('WebSocket is not connected')),
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
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

    const result = await blockWatch.getParentHeader(createHeaderInfo(110, '0xchild', '0xparent'));

    expect(prunedClient.rpc.chain.getHeader).toHaveBeenCalledWith('0xparent');
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0xparent');
    expect(result).toBe(parentHeader);
  });

  it('retries gap recovery on archive when the selected client times out', async () => {
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    const finalizedHeader = createHeaderInfo(100, '0x100', '0x099');
    const bestHeader = createHeaderInfo(101, '0x101', '0x100');
    const prunedClient = {
      rpc: {
        chain: {
          getHeader: vi.fn().mockRejectedValue(new Error('No response received from RPC endpoint in 60s')),
        },
      },
    };
    const archiveClient = {
      rpc: {
        chain: {
          getHeader: vi.fn().mockImplementation(async (hash?: string) => {
            if (hash) {
              return { __info: finalizedHeader };
            }
            return { __info: bestHeader };
          }),
        },
      },
    };
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);
    blockWatch.latestHeaders = [finalizedHeader];
    const blockWatchInternal = getInternalBlockWatch(blockWatch);
    blockWatchInternal.activeSource = 'pruned';

    await blockWatchInternal.setFinalizedHeader(createHeader(bestHeader));

    expect(prunedClient.rpc.chain.getHeader).toHaveBeenCalledWith();
    expect(prunedClient.rpc.chain.getHeader).toHaveBeenCalledWith('0x100');
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith();
    expect(archiveClient.rpc.chain.getHeader).toHaveBeenCalledWith('0x100');
    expect(blockWatch.bestBlockHeader.blockNumber).toBe(101);
    expect(blockWatch.finalizedBlockHeader.blockNumber).toBe(101);
  });

  it('starts on archive when the pruned client fails during startup', async () => {
    vi.spyOn(BlockWatch, 'readHeader').mockImplementation(readMockHeader);

    const finalizedHeader = createHeaderInfo(100, '0x100', '0x099');
    const prunedClient = {
      rpc: {
        chain: {
          getFinalizedHead: vi.fn().mockRejectedValue(new Error('WebSocket is not connected')),
        },
      },
    };
    const archiveClient = createSubscriptionClient(finalizedHeader);
    const blockWatch = new BlockWatch(createClients(prunedClient, archiveClient) as any);

    await blockWatch.start('pruned');

    expect(prunedClient.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
    expect(archiveClient.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
    expect(archiveClient.rpc.chain.subscribeNewHeads).toHaveBeenCalledOnce();
    expect(getInternalBlockWatch(blockWatch).activeSource).toBe('archive');
    expect(blockWatch.finalizedBlockHeader).toBe(finalizedHeader);
  });

  it('drops cached block APIs when subscriptions stop', async () => {
    const firstBlockApi = { query: { system: { events: vi.fn() } } };
    const secondBlockApi = { query: { system: { events: vi.fn() } } };
    const firstPrunedClient = { at: vi.fn().mockResolvedValue(firstBlockApi) };
    const secondPrunedClient = { at: vi.fn().mockResolvedValue(secondBlockApi) };
    const clients = createClients(firstPrunedClient, {}) as any;
    const blockWatch = new BlockWatch(clients);
    blockWatch.latestHeaders = [createHeaderInfo(100, '0xfinalized', '0xfinalized-parent')];
    getInternalBlockWatch(blockWatch).activeSource = 'pruned';

    const block = createHeaderInfo(110, '0xblock', '0xparent');
    expect(await blockWatch.getApi(block)).toBe(firstBlockApi);

    clients.prunedClientPromise = Promise.resolve(secondPrunedClient);
    blockWatch.stop();

    expect(await blockWatch.getApi(block)).toBe(secondBlockApi);
    expect(firstPrunedClient.at).toHaveBeenCalledOnce();
    expect(secondPrunedClient.at).toHaveBeenCalledOnce();
  });

  it('queues a follow-up restart requested during an active restart', async () => {
    vi.useFakeTimers();

    try {
      const blockWatch = new BlockWatch(createClients({}, {}) as any);
      const blockWatchInternal = getInternalBlockWatch(blockWatch);
      const firstRestart = createDeferredPromise<void>();

      blockWatchInternal.unsubscribe = vi.fn();
      const startMock = vi.spyOn(blockWatch, 'start').mockImplementation(async source => {
        blockWatchInternal.unsubscribe = vi.fn();
        if (source === 'archive') {
          await firstRestart.promise;
        }
      });

      const restartPromise = blockWatchInternal.restart('archive', 'Initial restart');
      blockWatchInternal.scheduleRestart('pruned', 'Promote recovered pruned client');
      firstRestart.resolve();

      await restartPromise;
      await vi.runAllTimersAsync();

      expect(startMock.mock.calls.map(([source]) => source)).toEqual(['archive', 'pruned']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed restart until subscriptions recover', async () => {
    vi.useFakeTimers();

    try {
      const blockWatch = new BlockWatch(createClients({}, {}) as any);
      const blockWatchInternal = getInternalBlockWatch(blockWatch);

      blockWatchInternal.unsubscribe = vi.fn();
      const startMock = vi.spyOn(blockWatch, 'start').mockImplementation(async () => {
        blockWatchInternal.unsubscribe = vi.fn();
        if (startMock.mock.calls.length === 1) {
          throw new Error('offline');
        }
      });

      await blockWatchInternal.restart('archive', 'Detected archive client degradation');
      expect(startMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(startMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes client event listeners on destroy', () => {
    const clientEventUnsubscribes = [vi.fn(), vi.fn(), vi.fn()];
    const blockWatch = new BlockWatch(createClients({}, {}, clientEventUnsubscribes) as any);

    blockWatch.destroy();

    for (const unsubscribe of clientEventUnsubscribes) {
      expect(unsubscribe).toHaveBeenCalledOnce();
    }
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

function createClients(prunedClient: unknown, archiveClient: unknown, clientEventUnsubscribes?: Array<() => void>) {
  let unsubscribeIndex = 0;
  return {
    prunedClientPromise: Promise.resolve(prunedClient),
    archiveClientPromise: Promise.resolve(archiveClient),
    events: {
      on: vi.fn().mockImplementation(() => clientEventUnsubscribes?.[unsubscribeIndex++] ?? (() => undefined)),
    },
  };
}

function createHeader({ blockHash, blockNumber }: IBlockHeaderInfo) {
  return {
    hash: { toHex: () => blockHash },
    number: { toNumber: () => blockNumber },
  };
}

function createSubscriptionClient(finalizedHeader: IBlockHeaderInfo) {
  return {
    rpc: {
      chain: {
        getFinalizedHead: vi.fn().mockResolvedValue(finalizedHeader.blockHash),
        getHeader: vi.fn().mockResolvedValue({ __info: finalizedHeader }),
        subscribeNewHeads: vi.fn(async () => vi.fn()),
        subscribeFinalizedHeads: vi.fn(async () => vi.fn()),
      },
    },
  };
}

function getInternalBlockWatch(blockWatch: BlockWatch) {
  return blockWatch as unknown as {
    activeSource: 'archive' | 'pruned';
    restart(source: 'archive' | 'pruned', reason: string): Promise<void>;
    scheduleRestart(source: 'archive' | 'pruned', reason: string, delayMs?: number): void;
    setFinalizedHeader(header: ReturnType<typeof createHeader>): Promise<void>;
    unsubscribe?: () => void;
  };
}

function readMockHeader(header: unknown): IBlockHeaderInfo {
  return (header as { __info: IBlockHeaderInfo }).__info;
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
