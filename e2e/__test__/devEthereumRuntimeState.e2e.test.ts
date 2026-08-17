import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TestEthereum } from '@argonprotocol/testing';
import { padHex, toFunctionSelector, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      let result: string | Address = runtimeState.chainId;
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
    runtimeStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argon-dev-ethereum-runtime-state-'));
    process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = runtimeStateDir;
  });

  afterEach(async () => {
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
