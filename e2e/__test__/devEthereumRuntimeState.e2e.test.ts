import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
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
  setupStatus: 'starting',
} as const;

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (filePath: string) => {
      const contents = fsState.files.get(String(filePath));
      if (contents !== undefined) {
        return contents;
      }

      const error = new Error(`Missing file: ${String(filePath)}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
      const contents = fsState.files.get(String(sourcePath));
      if (contents === undefined) {
        throw new Error(`Missing temporary file: ${String(sourcePath)}`);
      }

      fsState.files.set(String(destinationPath), contents);
      fsState.files.delete(String(sourcePath));
    }),
    rm: vi.fn(async (filePath: string) => {
      fsState.files.delete(String(filePath));
    }),
    writeFile: vi.fn(async (filePath: string, contents: string) => {
      fsState.files.set(String(filePath), String(contents));
    }),
  },
}));

import {
  readDevEthereumRuntimeState,
  updateDevEthereumRuntimeState,
  writeDevEthereumRuntimeState,
} from '../devEthereum.ts';

describe('dev Ethereum runtime state', () => {
  const previousRuntimeStateDir = process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;

  beforeEach(() => {
    fsState.files.clear();
  });

  afterEach(() => {
    if (previousRuntimeStateDir === undefined) {
      delete process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;
    } else {
      process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = previousRuntimeStateDir;
    }
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
    expect([...fsState.files.keys()].filter(filePath => filePath.endsWith('.tmp'))).toEqual([]);
  });

  it('stores state in the isolated test directory when configured', async () => {
    const runtimeStateDir = path.resolve('/isolated/session/test-data/dev-ethereum');
    process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = runtimeStateDir;

    await writeDevEthereumRuntimeState(runtimeState);

    expect([...fsState.files.keys()]).toHaveLength(2);
    expect([...fsState.files.keys()].every(filePath => filePath.startsWith(`${runtimeStateDir}${path.sep}`))).toBe(
      true,
    );
  });

  it('reads from the flow session directory instead of ambient process state', async () => {
    const runtimeStateDir = path.resolve('/isolated/session/test-data/dev-ethereum');
    process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = path.resolve('/different/session/dev-ethereum');
    const scopedStatePath = path.join(runtimeStateDir, 'http_127.0.0.1_32003.json');
    fsState.files.set(scopedStatePath, JSON.stringify(runtimeState));

    expect(await readDevEthereumRuntimeState(runtimeState.executionRpcUrl, runtimeStateDir)).toMatchObject(
      runtimeState,
    );
  });
});
