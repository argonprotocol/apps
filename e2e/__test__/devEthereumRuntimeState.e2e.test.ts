import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TestEthereum } from '@argonprotocol/testing';
import { padHex, toFunctionSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const runtimeState = {
  beaconPreset: 'minimal',
  enclaveName: 'argon-eth-test',
  executionRpcUrl: 'http://127.0.0.1:32003',
  beaconApiUrl: 'http://127.0.0.1:33001',
  chainId: '0x301824',
  serverExecutionRpcUrl: 'http://host.docker.internal:32003/',
  serverBeaconApiUrl: 'http://host.docker.internal:33001/',
  usdcTokenAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  gateway: {
    gatewayAddress: `0x${'11'.repeat(20)}`,
    argonTokenAddress: `0x${'22'.repeat(20)}`,
    argonotTokenAddress: `0x${'33'.repeat(20)}`,
  },
  setupStatus: 'starting',
} as const;

async function startEthereumRpc(gateway = runtimeState.gateway) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end('{}');
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number;
        method: string;
        params?: [{ data?: string }];
      };
      let result: unknown = runtimeState.chainId;
      if (['eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(body.method)) result = '0x1';
      if (body.method === 'eth_getTransactionCount') result = '0x0';
      if (body.method === 'eth_estimateGas') result = '0x300000';
      if (body.method === 'eth_getBlockByNumber') {
        result = { number: '0x1', baseFeePerGas: '0x1', transactions: [] };
      }
      if (body.method === 'eth_sendRawTransaction') result = `0x${'ab'.repeat(32)}`;
      if (body.method === 'eth_getTransactionReceipt') {
        result = {
          blockHash: `0x${'cd'.repeat(32)}`,
          blockNumber: '0x1',
          contractAddress: runtimeState.usdcTokenAddress,
          cumulativeGasUsed: '0x200000',
          effectiveGasPrice: '0x1',
          from: `0x${'aa'.repeat(20)}`,
          gasUsed: '0x200000',
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          to: null,
          transactionHash: `0x${'ab'.repeat(32)}`,
          transactionIndex: '0x0',
          type: '0x2',
        };
      }
      const callData = body.params?.[0]?.data;
      if (body.method === 'eth_call' && callData?.startsWith(toFunctionSelector('argonToken()'))) {
        result = padHex(gateway.argonTokenAddress, { size: 32 });
      }
      if (body.method === 'eth_call' && callData?.startsWith(toFunctionSelector('argonotToken()'))) {
        result = padHex(gateway.argonotTokenAddress, { size: 32 });
      }

      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve test Ethereum RPC address.');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

import {
  readDevEthereumRuntimeState,
  resolveDevEthereumRpcUrl,
  startDevEthereum,
  updateDevEthereumRuntimeState,
  writeDevEthereumRuntimeState,
} from '../devEthereum.ts';

describe('dev Ethereum runtime state', () => {
  const previousRuntimeStateDir = process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;
  let runtimeStateDir: string;

  beforeEach(async () => {
    vi.mocked(execFileSync).mockReset().mockReturnValue('');
    vi.spyOn(TestEthereum.prototype, 'teardown').mockResolvedValue(undefined);
    runtimeStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argon-dev-ethereum-runtime-state-'));
    process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = runtimeStateDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousRuntimeStateDir === undefined) {
      delete process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;
    } else {
      process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = previousRuntimeStateDir;
    }
    await fs.rm(runtimeStateDir, { recursive: true, force: true });
  });

  it('preserves concurrent setup and minting authority updates', async () => {
    const { executionRpcUrl } = runtimeState;
    await writeDevEthereumRuntimeState(runtimeState);

    await Promise.all([
      updateDevEthereumRuntimeState(executionRpcUrl, { setupStatus: 'ready' }),
      updateDevEthereumRuntimeState(executionRpcUrl, { mintingAuthorityStatus: 'ready' }),
    ]);

    expect(await readDevEthereumRuntimeState(executionRpcUrl)).toMatchObject({
      executionRpcUrl,
      setupStatus: 'ready',
      mintingAuthorityStatus: 'ready',
    });
    expect((await fs.readdir(runtimeStateDir)).filter(filePath => filePath.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['starting', 'ready'] as const)(
    'reuses a reachable %s deployment across Tauri restarts',
    async setupStatus => {
      const rpc = await startEthereumRpc();
      await writeDevEthereumRuntimeState({
        ...runtimeState,
        executionRpcUrl: rpc.url,
        beaconApiUrl: rpc.url,
        serverExecutionRpcUrl: rpc.url,
        serverBeaconApiUrl: rpc.url,
        setupStatus,
      });

      try {
        const ethereum = await startDevEthereum({
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        });

        expect(ethereum.enclaveName).toBe(runtimeState.enclaveName);
        expect(ethereum.executionRpcUrl).toBe(rpc.url);
        expect(ethereum.gateway).toEqual(runtimeState.gateway);
        expect(execFileSync).not.toHaveBeenCalled();
        if (setupStatus === 'ready') {
          await expect(resolveDevEthereumRpcUrl({})).resolves.toBe(rpc.url);
        } else {
          await expect(resolveDevEthereumRpcUrl({})).rejects.toThrow('Local Ethereum setup has not finished');
        }
      } finally {
        await rpc.close();
      }
    },
  );

  it('replaces a deployment whose beacon endpoint is unavailable', async () => {
    const rpc = await startEthereumRpc();
    const isInstalled = vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
    const launch = vi
      .spyOn(TestEthereum.prototype, 'launch')
      .mockRejectedValue(new Error('Started a replacement Ethereum enclave'));
    await writeDevEthereumRuntimeState({
      ...runtimeState,
      executionRpcUrl: rpc.url,
      beaconApiUrl: 'http://127.0.0.1:1',
      serverExecutionRpcUrl: rpc.url,
      setupStatus: 'ready',
    });

    try {
      await expect(
        startDevEthereum({
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        }),
      ).rejects.toThrow('Started a replacement Ethereum enclave');
    } finally {
      launch.mockRestore();
      isInstalled.mockRestore();
      await rpc.close();
    }
  });

  it.each([
    { aggregator: 'exited', proxy: 'running' },
    { aggregator: 'created', proxy: 'running' },
    { aggregator: 'running', proxy: 'running' },
    { aggregator: 'absent', proxy: 'absent' },
    { aggregator: 'running', proxy: 'exited' },
    { aggregator: 'running', proxy: 'stale-network' },
    { aggregator: 'running', proxy: 'interrupted-rebuild' },
  ])('launches and saves a deployment with aggregator $aggregator and proxy $proxy', async ({ aggregator, proxy }) => {
    const rpc = await startEthereumRpc();
    let aggregatorStatus = aggregator === 'absent' ? '' : aggregator;
    let proxyStatus = ['stale-network', 'interrupted-rebuild'].includes(proxy) ? 'exited' : proxy;
    let engineRunning = proxy !== 'absent';
    let restartFails = proxy === 'interrupted-rebuild';
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      if (file === 'kurtosis' && args?.join(' ') === 'engine restart --restart-api-containers=false') {
        if (restartFails) {
          restartFails = false;
          throw new Error('Synthetic engine restart failed');
        }
        engineRunning = true;
        proxyStatus = 'running';
        aggregatorStatus = 'exited';
        return '';
      }
      if (file === 'docker' && args?.[0] === 'ps') {
        if (args.includes('label=com.kurtosistech.container-type=kurtosis-reverse-proxy')) {
          return proxyStatus === 'absent' ? '' : `abcdef012345\t${proxyStatus}`;
        }
        if (args.includes('label=com.kurtosistech.container-type=kurtosis-engine')) {
          return engineRunning ? 'synthetic-engine' : '';
        }
        if (args.includes('label=com.kurtosistech.enclave-id')) return '';
        expect(args).toEqual(['ps', '--all', '--filter', 'name=^/kurtosis-logs-aggregator$', '--format', '{{.State}}']);
        return aggregatorStatus;
      }
      if (file === 'docker' && args?.join(' ') === 'start kurtosis-logs-aggregator') {
        aggregatorStatus = 'running';
        return 'kurtosis-logs-aggregator';
      }
      if (file === 'docker' && args?.join(' ') === 'start abcdef012345') {
        if (['stale-network', 'interrupted-rebuild'].includes(proxy)) {
          throw new Error('network kt-deleted-test-enclave not found');
        }
        proxyStatus = 'running';
        return 'abcdef012345';
      }
      if (file === 'docker' && args?.join(' ') === 'rm abcdef012345') {
        proxyStatus = 'absent';
        return 'abcdef012345';
      }
      throw new Error(`Unexpected command: ${file} ${args?.join(' ')}`);
    });
    vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
    vi.spyOn(TestEthereum.prototype, 'launch').mockImplementation(async () => {
      // Kurtosis creates missing infrastructure, but cannot reuse a stopped aggregator.
      if (!aggregatorStatus) aggregatorStatus = 'running';
      if (aggregatorStatus !== 'running') {
        throw new Error('The logs aggregator container exists but is not running.');
      }
      if (proxyStatus === 'absent' && !engineRunning) proxyStatus = 'running';
      if (proxyStatus !== 'running') {
        throw new Error('An error occurred while getting the reverse proxy enclave network IP address');
      }
      return { executionRpcUrl: rpc.url, beaconApiUrl: rpc.url, chainId: runtimeState.chainId };
    });

    try {
      const config = {
        beaconPreset: 'minimal' as const,
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      };
      if (proxy === 'interrupted-rebuild') {
        await expect(startDevEthereum(config)).rejects.toThrow('Synthetic engine restart failed');
        expect(proxyStatus).toBe('absent');
        expect(await readDevEthereumRuntimeState()).toBeUndefined();
      }
      const ethereum = await startDevEthereum(config);

      expect(aggregatorStatus).toBe('running');
      expect(proxyStatus).toBe('running');
      expect(await readDevEthereumRuntimeState()).toMatchObject({
        enclaveName: ethereum.enclaveName,
        executionRpcUrl: rpc.url,
        usdcTokenAddress: runtimeState.usdcTokenAddress,
        setupStatus: 'starting',
      });
      const aggregatorStarts = vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) => args?.join(' ') === 'start kurtosis-logs-aggregator');
      const needsAggregatorStart =
        ['exited', 'created'].includes(aggregator) || ['stale-network', 'interrupted-rebuild'].includes(proxy);
      expect(aggregatorStarts).toHaveLength(Number(needsAggregatorStart));
    } finally {
      await rpc.close();
    }
  });

  it.each([
    'Bind for 0.0.0.0:55009 failed: port is already allocated',
    'failed to bind port 127.0.0.1:55009/tcp: listen tcp4 127.0.0.1:55009: bind: address already in use',
  ])('cleans up a failed launch and saves the deployment after retrying %s', async message => {
    const rpc = await startEthereumRpc();
    vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
    const teardown = vi.spyOn(TestEthereum.prototype, 'teardown');
    const launch = vi
      .spyOn(TestEthereum.prototype, 'launch')
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue({ executionRpcUrl: rpc.url, beaconApiUrl: rpc.url, chainId: runtimeState.chainId });

    try {
      const ethereum = await startDevEthereum({
        beaconPreset: 'minimal',
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      });

      expect(await readDevEthereumRuntimeState()).toMatchObject({
        enclaveName: ethereum.enclaveName,
        executionRpcUrl: rpc.url,
        usdcTokenAddress: runtimeState.usdcTokenAddress,
        setupStatus: 'starting',
      });
      expect(launch).toHaveBeenCalledTimes(2);
      expect(teardown).toHaveBeenCalledOnce();
      expect(teardown.mock.contexts[0]).toBe(launch.mock.contexts[0]);
      expect(launch.mock.contexts[1]).not.toBe(launch.mock.contexts[0]);
    } finally {
      await rpc.close();
    }
  });

  it.each([
    { message: 'port is already allocated', attempts: 3 },
    { message: 'failed to bind port 127.0.0.1:55009/tcp: bind: address already in use', attempts: 3 },
    { message: 'Unable to pull Ethereum client image', attempts: 1 },
  ])('leaves no deployment after $attempts failed attempts for $message', async ({ message, attempts }) => {
    const error = new Error(message);
    vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
    const teardown = vi.spyOn(TestEthereum.prototype, 'teardown');
    const launch = vi.spyOn(TestEthereum.prototype, 'launch').mockRejectedValue(error);

    await expect(
      startDevEthereum({
        beaconPreset: 'minimal',
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      }),
    ).rejects.toBe(error);

    expect(await readDevEthereumRuntimeState()).toBeUndefined();
    expect(await fs.readdir(runtimeStateDir)).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(attempts);
    expect(teardown.mock.contexts).toEqual(launch.mock.contexts);
  });

  it.each(['active enclave', 'unrelated start error', 'proxy exits after starting'])(
    'does not rebuild the shared proxy on %s',
    async failure => {
      const activeEnclave = failure === 'active enclave' ? 'synthetic-enclave-api' : '';
      vi.mocked(execFileSync).mockImplementation((file, args) => {
        if (file === 'docker' && args?.[0] === 'ps') {
          if (args.includes('label=com.kurtosistech.container-type=kurtosis-reverse-proxy')) {
            return 'abcdef012345\texited';
          }
          if (args.includes('label=com.kurtosistech.enclave-id')) return activeEnclave;
          return 'running';
        }
        if (file === 'docker' && args?.join(' ') === 'start abcdef012345') {
          if (failure === 'proxy exits after starting') return 'abcdef012345';
          if (failure === 'unrelated start error') throw new Error('port is already allocated');
          throw new Error('network kt-deleted-test-enclave not found');
        }
        throw new Error(`Unexpected command: ${file} ${args?.join(' ')}`);
      });
      vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
      const launch = vi.spyOn(TestEthereum.prototype, 'launch').mockRejectedValue(new Error('Unexpected launch'));

      await expect(
        startDevEthereum({
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        }),
      ).rejects.toThrow(failure === 'active enclave' ? 'Other Kurtosis enclaves are active' : 'Kurtosis reverse proxy');

      expect(launch).not.toHaveBeenCalled();
      expect(await readDevEthereumRuntimeState()).toBeUndefined();
      expect(vi.mocked(execFileSync).mock.calls.some(([file, args]) => file === 'kurtosis' || args?.[0] === 'rm')).toBe(
        false,
      );
    },
  );

  it.each(['start fails', 'exits after starting', 'paused'])(
    'blocks enclave creation on logs aggregator failure: %s',
    async failure => {
      vi.mocked(execFileSync).mockImplementation((file, args) => {
        if (file === 'docker' && args?.[0] === 'ps') return failure === 'paused' ? 'paused' : 'exited';
        if (file === 'docker' && args?.join(' ') === 'start kurtosis-logs-aggregator') {
          if (failure === 'start fails') throw new Error('Docker could not start the container');
          return 'kurtosis-logs-aggregator';
        }
        throw new Error(`Unexpected command: ${file} ${args?.join(' ')}`);
      });
      vi.spyOn(TestEthereum, 'isInstalled').mockReturnValue(true);
      const launch = vi.spyOn(TestEthereum.prototype, 'launch').mockRejectedValue(new Error('Unexpected launch'));

      await expect(
        startDevEthereum({
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        }),
      ).rejects.toThrow('docker logs kurtosis-logs-aggregator');

      expect(launch).not.toHaveBeenCalled();
      expect(await readDevEthereumRuntimeState()).toBeUndefined();
      if (failure === 'paused') {
        expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => args?.[0] === 'start')).toBe(false);
      }
    },
  );

  it('recovers a reachable prior deployment when the latest deployment is unavailable', async () => {
    const rpc = await startEthereumRpc();
    await writeDevEthereumRuntimeState({
      ...runtimeState,
      executionRpcUrl: rpc.url,
      beaconApiUrl: rpc.url,
      serverExecutionRpcUrl: rpc.url,
      serverBeaconApiUrl: rpc.url,
      setupStatus: 'ready',
    });
    await writeDevEthereumRuntimeState({
      ...runtimeState,
      enclaveName: 'argon-eth-stopped',
      executionRpcUrl: 'http://127.0.0.1:1',
      beaconApiUrl: 'http://127.0.0.1:2',
      serverExecutionRpcUrl: 'http://127.0.0.1:1',
      serverBeaconApiUrl: 'http://127.0.0.1:2',
      setupStatus: 'starting',
    });

    try {
      const ethereum = await startDevEthereum({
        beaconPreset: 'minimal',
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      });

      expect(ethereum.enclaveName).toBe(runtimeState.enclaveName);
      expect(ethereum.executionRpcUrl).toBe(rpc.url);
      await expect(readDevEthereumRuntimeState()).resolves.toMatchObject({ executionRpcUrl: rpc.url });
    } finally {
      await rpc.close();
    }
  });

  it('recovers the deployment that matches the configured mainchain gateway', async () => {
    const compatibleRpc = await startEthereumRpc();
    const incompatibleGateway: typeof runtimeState.gateway = {
      gatewayAddress: `0x${'44'.repeat(20)}`,
      argonTokenAddress: `0x${'55'.repeat(20)}`,
      argonotTokenAddress: `0x${'66'.repeat(20)}`,
    };
    const incompatibleRpc = await startEthereumRpc(incompatibleGateway);
    await writeDevEthereumRuntimeState({
      ...runtimeState,
      executionRpcUrl: compatibleRpc.url,
      beaconApiUrl: compatibleRpc.url,
      serverExecutionRpcUrl: compatibleRpc.url,
      serverBeaconApiUrl: compatibleRpc.url,
      setupStatus: 'ready',
    });
    await writeDevEthereumRuntimeState({
      ...runtimeState,
      enclaveName: 'argon-eth-incompatible',
      executionRpcUrl: incompatibleRpc.url,
      beaconApiUrl: incompatibleRpc.url,
      serverExecutionRpcUrl: incompatibleRpc.url,
      serverBeaconApiUrl: incompatibleRpc.url,
      gateway: incompatibleGateway,
      setupStatus: 'starting',
    });

    try {
      const ethereum = await startDevEthereum(
        {
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        },
        runtimeState.gateway,
      );

      expect(ethereum.enclaveName).toBe(runtimeState.enclaveName);
      expect(ethereum.executionRpcUrl).toBe(compatibleRpc.url);
    } finally {
      await Promise.all([compatibleRpc.close(), incompatibleRpc.close()]);
    }
  });

  it('stores state in the isolated test directory when configured', async () => {
    await writeDevEthereumRuntimeState(runtimeState);

    const stateFiles = await fs.readdir(runtimeStateDir);
    expect(stateFiles).toHaveLength(2);
    expect(stateFiles).toContain('latest.json');
  });

  it('reads from the flow session directory instead of ambient process state', async () => {
    const flowRuntimeStateDir = path.join(runtimeStateDir, 'flow');
    process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = path.join(runtimeStateDir, 'ambient');
    await fs.mkdir(flowRuntimeStateDir);
    await fs.writeFile(path.join(flowRuntimeStateDir, 'http_127.0.0.1_32003.json'), JSON.stringify(runtimeState));

    expect(await readDevEthereumRuntimeState(runtimeState.executionRpcUrl, flowRuntimeStateDir)).toMatchObject(
      runtimeState,
    );
  });
});
