import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callArgonRpc: vi.fn(),
  readTextFileOrDefault: vi.fn().mockResolvedValue('100'),
}));

vi.mock('../src/env.ts', () => ({
  LOCAL_NODE_URL: 'http://argon-miner:9944',
  LOGS_DIR: '/tmp',
  MAIN_NODE_URL: 'https://archive.argon.network',
}));

vi.mock('../src/utils.ts', async importOriginal => ({
  ...(await importOriginal()),
  callArgonRpc: mocks.callArgonRpc,
  readTextFileOrDefault: mocks.readTextFileOrDefault,
}));

import { ArgonApis } from '../src/ArgonApis.ts';

describe('ArgonApis sync status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.callArgonRpc.mockReset();
    mocks.readTextFileOrDefault.mockResolvedValue('100');
  });

  it('uses state sync progress in the final third of fast sync', async () => {
    mocks.callArgonRpc.mockResolvedValue({
      result: {
        startingBlock: 0,
        currentBlock: 10,
        state: 'downloading',
        targetBlock: 1_000,
        bestSeenBlock: 1_000,
        numPeers: 3,
        stateSync: {
          percentage: 65,
          phase: 'downloadingState',
        },
        warpSync: null,
      },
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 89.6,
      localNodeBlockNumber: 10,
      mainNodeBlockNumber: 1_000,
    });
    expect(mocks.callArgonRpc).toHaveBeenCalledWith('http://argon-miner:9944', 'system_syncStatus');
  });

  it('measures ordinary block sync from the node startup height', async () => {
    mocks.callArgonRpc.mockResolvedValue({
      result: {
        startingBlock: 100,
        currentBlock: 550,
        state: 'downloading',
        targetBlock: 1_000,
        bestSeenBlock: 1_000,
        numPeers: 3,
        stateSync: null,
        warpSync: null,
      },
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 46.6,
      localNodeBlockNumber: 550,
      mainNodeBlockNumber: 1_000,
    });
  });

  it('hands header progress into state download without moving backward', async () => {
    mocks.callArgonRpc
      .mockResolvedValueOnce({
        result: {
          startingBlock: 100,
          currentBlock: 1_000,
          state: 'downloading',
          targetBlock: 1_000,
          bestSeenBlock: 1_000,
          numPeers: 3,
          stateSync: null,
          warpSync: null,
        },
      })
      .mockResolvedValueOnce({
        result: {
          startingBlock: 100,
          currentBlock: 1_000,
          state: 'downloading',
          targetBlock: 1_000,
          bestSeenBlock: 1_000,
          numPeers: 3,
          stateSync: {
            percentage: 0,
            phase: 'downloadingState',
          },
          warpSync: null,
        },
      });

    const headersComplete = await ArgonApis.syncStatus();
    const stateStarted = await ArgonApis.syncStatus();

    expect(headersComplete.syncPercent).toBe(73.3);
    expect(stateStarted.syncPercent).toBe(headersComplete.syncPercent);
  });

  it('holds progress at the state import checkpoint until import completes', async () => {
    mocks.callArgonRpc.mockResolvedValue({
      result: {
        startingBlock: 0,
        currentBlock: 10,
        state: 'idle',
        targetBlock: 1_000,
        bestSeenBlock: 1_000,
        numPeers: 3,
        stateSync: {
          percentage: 100,
          phase: 'importingState',
        },
        warpSync: null,
      },
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 99.2,
      localNodeBlockNumber: 10,
      mainNodeBlockNumber: 1_000,
    });
  });

  it('finishes idle sync when the best seen block remains ahead', async () => {
    mocks.callArgonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'system_syncStatus') {
        return {
          result: {
            startingBlock: 0,
            currentBlock: 999,
            state: 'idle',
            targetBlock: null,
            bestSeenBlock: 1_000,
            numPeers: 3,
            stateSync: null,
            warpSync: null,
          },
        };
      }

      if (method === 'state_getRuntimeVersion') {
        return { result: { specVersion: 1 } };
      }

      return { result: { isSyncing: false, peers: 3 } };
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 100,
      localNodeBlockNumber: 999,
      mainNodeBlockNumber: 999,
    });
  });

  it('finishes idle sync without peers when the local block has reached the archive', async () => {
    mocks.callArgonRpc.mockImplementation(async (url: string, method: string) => {
      if (method === 'system_syncStatus') {
        return {
          result: {
            startingBlock: 0,
            currentBlock: 1_000,
            state: 'idle',
            targetBlock: null,
            bestSeenBlock: null,
            numPeers: 0,
            stateSync: null,
            warpSync: null,
          },
        };
      }

      if (method === 'chain_getHeader') {
        expect(url).toBe('https://archive.argon.network');
        return { result: { number: '0x3e8' } };
      }

      if (method === 'state_getRuntimeVersion') {
        return { result: { specVersion: 1 } };
      }

      return { result: { isSyncing: false, peers: 0 } };
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 100,
      localNodeBlockNumber: 1_000,
      mainNodeBlockNumber: 1_000,
    });
  });

  it('keeps syncing an idle node without peers when the archive is ahead', async () => {
    mocks.callArgonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'system_syncStatus') {
        return {
          result: {
            startingBlock: 0,
            currentBlock: 500,
            state: 'idle',
            targetBlock: null,
            bestSeenBlock: null,
            numPeers: 0,
            stateSync: null,
            warpSync: null,
          },
        };
      }

      return { result: { number: '0x3e8' } };
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 46.6,
      localNodeBlockNumber: 500,
      mainNodeBlockNumber: 1_000,
    });
  });

  it('does not report warp proof download as completed block sync', async () => {
    mocks.callArgonRpc.mockResolvedValue({
      result: {
        startingBlock: 10,
        currentBlock: 10,
        state: 'idle',
        targetBlock: null,
        bestSeenBlock: 1_000,
        numPeers: 3,
        stateSync: null,
        warpSync: {
          phase: 'downloadingWarpProofs',
        },
      },
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 20,
      localNodeBlockNumber: 10,
      mainNodeBlockNumber: 1_000,
    });
  });

  it('falls back to archive height progress for nodes without the sync status rpc', async () => {
    mocks.callArgonRpc.mockImplementation(async (url: string, method: string) => {
      if (method === 'system_syncStatus') {
        return { error: { code: -32601, message: 'Method not found' } };
      }

      return {
        result: {
          number: url === 'http://argon-miner:9944' ? '0x32' : '0x64',
        },
      };
    });

    await expect(ArgonApis.syncStatus()).resolves.toEqual({
      syncPercent: 60,
      localNodeBlockNumber: 50,
      mainNodeBlockNumber: 100,
    });
  });
});
