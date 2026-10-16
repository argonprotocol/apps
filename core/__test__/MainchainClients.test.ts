import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainchainClients } from '../src/MainchainClients.ts';
import { Vaults } from '../src/Vaults.ts';
import { BlockWatch } from '../src/BlockWatch.ts';
import { MiningFrames } from '../src/MiningFrames.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';

const getMainchainClient = vi.hoisted(() => vi.fn());

vi.mock('../src/MainchainRpcProvider.ts', () => ({ getMainchainClient }));

describe('MainchainClients', () => {
  let clients: MainchainClients;
  let archiveClient: ReturnType<typeof createClient>;
  let prunedClient: ReturnType<typeof createClient>;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    archiveClient = createClient('archive');
    prunedClient = createClient('pruned');
    getMainchainClient.mockImplementation(async (url: string) =>
      url === 'ws://archive' ? archiveClient : prunedClient,
    );
    clients = new MainchainClients('ws://archive', () => false);
  });

  afterEach(async () => {
    await clients.disconnect();
    getMainchainClient.mockReset();
    vi.restoreAllMocks();
  });

  it('selects a connected candidate only after its state probe succeeds', async () => {
    let finishProbe!: (blockNumber: number) => void;
    const stateProbe = new Promise<number>(resolve => {
      finishProbe = resolve;
    });
    prunedClient = createClient('pruned', {
      finalizedStateNumber: vi.fn(() => stateProbe),
    });

    const prunedReady = clients.setPrunedClient('ws://pruned');
    let didResolvePrunedReady = false;
    void prunedReady.then(() => {
      didResolvePrunedReady = true;
    });
    await vi.waitFor(() => expect(prunedClient.finalizedStateNumber).toHaveBeenCalledOnce());

    await expect(clients.prunedClientOrArchivePromise).resolves.toMatchObject({ name: 'archive' });
    await expect(clients.get(false)).resolves.toMatchObject({ name: 'archive', clientType: 'archive' });
    expect(didResolvePrunedReady).toBe(false);
    finishProbe(100);
    await expect(prunedReady).resolves.toMatchObject({ name: 'pruned' });

    expect(prunedClient.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
    expect(prunedClient.at).toHaveBeenCalledWith('0xfinalized');
    expect(prunedClient.finalizedStateNumber).toHaveBeenCalledOnce();
    await expect(clients.prunedClientOrArchivePromise).resolves.toMatchObject({ name: 'pruned' });
    await expect(clients.get(false)).resolves.toMatchObject({ name: 'pruned', clientType: 'pruned' });
    await expect(clients.get(true)).resolves.toMatchObject({ name: 'archive', clientType: 'archive' });
  });

  it('keeps a preferred candidate when its state probe succeeds and demotes it when the next probe fails', async () => {
    prunedClient = createClient('pruned', {
      currentStateNumber: vi.fn().mockRejectedValue(new Error('4003: State already discarded')),
      finalizedStateNumber: vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(100)
        .mockRejectedValueOnce(new Error('4003: State already discarded')),
    });

    await clients.setPrunedClient('ws://pruned');
    await vi.waitFor(() => expect(clients.prunedClientPromise).toBeDefined());
    const selectedClient = await clients.get(false);

    await expect(selectedClient.query.system.number()).rejects.toThrow('State already discarded');

    await vi.waitFor(() => expect(prunedClient.finalizedStateNumber).toHaveBeenCalledTimes(2));
    await expect(clients.get(false)).resolves.toMatchObject({ name: 'pruned', clientType: 'pruned' });

    await expect(selectedClient.query.system.number()).rejects.toThrow('State already discarded');
    await vi.waitFor(() => expect(clients.prunedClientPromise).toBeUndefined());

    await expect(clients.get(false)).resolves.toMatchObject({ name: 'archive', clientType: 'archive' });
  });

  it('restores a disconnected candidate only after its current-state probe succeeds', async () => {
    await clients.setPrunedClient('ws://pruned');
    await vi.waitFor(() => expect(clients.prunedClientPromise).toBeDefined());

    prunedClient.emit('disconnected');
    await expect(clients.get(false)).resolves.toMatchObject({ name: 'archive', clientType: 'archive' });

    prunedClient.emit('connected');
    await vi.waitFor(() => expect(prunedClient.finalizedStateNumber).toHaveBeenCalledTimes(2));
    await expect(clients.get(false)).resolves.toMatchObject({ name: 'pruned', clientType: 'pruned' });
  });

  it('reloads current reward configuration when the selected archive reconnects', async () => {
    NetworkConfig.setNetwork('dev-docker');
    Object.assign(archiveClient.query, {
      treasury: { upstreamParticipationFactor: async () => new BigNumber(0.25) },
    });
    const finalizedApi = {
      consts: { treasury: {} },
      query: {
        system: { number: async () => 100 },
        treasury: { upstreamParticipationFactor: async () => new BigNumber(0.05) },
      },
      tx: {},
    };
    const initialHeader = BlockWatch.readHeader(getOfflineRegistry().createType('Header', { number: 100 }), true);
    const nextHeader = BlockWatch.readHeader(getOfflineRegistry().createType('Header', { number: 101 }), true);
    const nextApi = {
      tx: {},
      consts: finalizedApi.consts,
      query: {
        system: { number: async () => 101 },
        treasury: { upstreamParticipationFactor: async () => new BigNumber(0.25) },
      },
    };
    archiveClient.at.mockImplementation(async hash => (hash === nextHeader.blockHash ? nextApi : finalizedApi));

    await clients.get(false);
    const blockWatch = new BlockWatch(clients);
    const miningFrames = new MiningFrames(clients, blockWatch);
    blockWatch.latestHeaders = [initialHeader];
    blockWatch.isLoaded.resolve();
    const vaults = new Vaults('dev-docker', {} as any, miningFrames, clients);
    try {
      await vi.waitFor(() => expect(vaults.currentState.upstreamParticipationFactor?.toNumber()).toBe(0.05));

      archiveClient.emit('disconnected');
      archiveClient.emit('connected');
      await new Promise(resolve => setImmediate(resolve));
      expect(vaults.currentState.upstreamParticipationFactor?.toNumber()).toBe(0.05);

      blockWatch.latestHeaders = [nextHeader];
      blockWatch.events.emit('finalized', [nextHeader]);
      await vi.waitFor(() => expect(vaults.currentState.upstreamParticipationFactor?.toNumber()).toBe(0.25));
    } finally {
      blockWatch.destroy();
    }
  });

  it('deduplicates state probes and retries one that stalls', async () => {
    vi.useFakeTimers();
    prunedClient = createClient('pruned', {
      currentStateNumber: vi.fn(() => Promise.reject(new Error('4003: State already discarded'))),
      finalizedStateNumber: vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockImplementationOnce(() => new Promise<number>(() => undefined))
        .mockResolvedValue(100),
    });

    try {
      await clients.setPrunedClient('ws://pruned');
      await vi.waitFor(() => expect(clients.prunedClientPromise).toBeDefined());
      const selectedClient = await clients.get(false);

      await Promise.allSettled([selectedClient.query.system.number(), selectedClient.query.system.number()]);
      await vi.waitFor(() => expect(prunedClient.finalizedStateNumber).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(65_000);
      await vi.waitFor(() => expect(prunedClient.finalizedStateNumber).toHaveBeenCalledTimes(3));

      await expect(clients.get(false)).resolves.toMatchObject({ name: 'pruned' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a degraded event when clearing an active pruned client', async () => {
    const degraded = vi.fn();

    clients.events.on('degraded', degraded);
    await clients.setPrunedClient('ws://pruned');
    await vi.waitFor(() => expect(clients.prunedClientPromise).toBeDefined());

    clients.clearPrunedClient();
    await vi.waitFor(() => expect(prunedClient.disconnect).toHaveBeenCalledOnce());

    expect(degraded).toHaveBeenCalledOnce();
    expect(degraded).toHaveBeenCalledWith(undefined, 'pruned');
  });

  it('disconnects the previous candidate when its replacement fails to connect', async () => {
    const previousClient = createClient('previous');
    getMainchainClient.mockResolvedValueOnce(previousClient).mockRejectedValueOnce(new Error('Replacement failed'));

    await clients.setPrunedClient('ws://previous');

    await expect(clients.setPrunedClient('ws://replacement')).rejects.toThrow('Replacement failed');
    await vi.waitFor(() => expect(previousClient.disconnect).toHaveBeenCalledOnce());
  });
});

function createClient(
  name: string,
  options: {
    currentStateNumber?: ReturnType<typeof vi.fn>;
    finalizedStateNumber?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const listeners: Record<string, Array<() => void>> = {};
  const currentStateNumber = options.currentStateNumber ?? vi.fn().mockResolvedValue(100);
  const finalizedStateNumber = options.finalizedStateNumber ?? vi.fn().mockResolvedValue(100);
  const finalizedApi = {
    query: { system: { number: finalizedStateNumber } },
    tx: {},
  };

  return {
    name,
    tx: {},
    query: { system: { number: currentStateNumber } },
    rpc: {
      chain: {
        getFinalizedHead: vi.fn().mockResolvedValue('0xfinalized'),
      },
    },
    at: vi.fn().mockResolvedValue(finalizedApi),
    finalizedStateNumber,
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] ??= [];
      listeners[event].push(listener);
    }),
    emit: (event: string) => {
      for (const listener of listeners[event] ?? []) {
        listener();
      }
    },
    disconnect: vi.fn(async () => {
      for (const listener of listeners.disconnected ?? []) {
        listener();
      }
    }),
  };
}
