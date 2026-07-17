import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const runtimeState = {
  beaconPreset: 'minimal',
  enclaveName: 'argon-eth-test',
  executionRpcUrl: 'http://127.0.0.1:32003',
  beaconApiUrl: 'http://127.0.0.1:33001',
  chainId: '0x301824',
  serverExecutionRpcUrl: 'http://host.docker.internal:32003/',
  serverBeaconApiUrl: 'http://host.docker.internal:33001/',
  usdcTokenAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  setupStatus: 'starting',
} as const;

import {
  readDevEthereumRuntimeState,
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
