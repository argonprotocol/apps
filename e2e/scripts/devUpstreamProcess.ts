import { spawn } from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INetworkConfigOverride } from '@argonprotocol/apps-core';
import type { IDevEthereumConfig, IStartDevEthereumResult } from '../devEthereum.ts';

const WORKER_START_TIMEOUT_MS = 120_000;
const WORKER_STOP_TIMEOUT_MS = 10_000;

export interface IDevUpstreamWorkerStartOptions {
  archiveUrl: string;
  devEthereum?: Pick<IStartDevEthereumResult, 'serverBeaconApiUrl' | 'serverExecutionRpcUrl' | 'usdcTokenAddress'>;
  devEthereumConfig?: Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis'>;
  env: NodeJS.ProcessEnv;
  executionRpcUrl?: string;
  networkConfigOverride?: INetworkConfigOverride;
  rootDir: string;
}

export function getDevUpstreamWorkerPaths(rootDir: string) {
  const configDir = Path.join(rootDir, 'config');
  return {
    logPath: Path.join(rootDir, 'operator-worker.log'),
    pidPath: Path.join(configDir, 'operator-worker.pid'),
    readyPath: Path.join(configDir, 'operator-worker.ready'),
  };
}

export async function ensureDevUpstreamWorker(options: IDevUpstreamWorkerStartOptions): Promise<number> {
  const paths = getDevUpstreamWorkerPaths(options.rootDir);
  const runningPid = readRunningWorkerPid(paths.pidPath);
  if (runningPid) {
    await waitForWorkerReady(paths, runningPid);
    return runningPid;
  }

  Fs.mkdirSync(Path.dirname(paths.pidPath), { recursive: true });
  Fs.rmSync(paths.pidPath, { force: true });
  Fs.rmSync(paths.readyPath, { force: true });

  const logFd = Fs.openSync(paths.logPath, 'a');
  const workerPath = Path.join(Path.dirname(fileURLToPath(import.meta.url)), 'devUpstreamWorker.ts');
  const child = spawn('tsx', [workerPath], {
    cwd: options.rootDir,
    detached: true,
    env: {
      ...options.env,
      ARGON_DEV_UPSTREAM_ARCHIVE_URL: options.archiveUrl,
      ARGON_DEV_UPSTREAM_ETHEREUM: options.devEthereum ? JSON.stringify(options.devEthereum) : '',
      ARGON_DEV_UPSTREAM_ETHEREUM_CONFIG: options.devEthereumConfig ? JSON.stringify(options.devEthereumConfig) : '',
      ARGON_DEV_UPSTREAM_EXECUTION_RPC_URL: options.executionRpcUrl ?? '',
      ARGON_DEV_UPSTREAM_NETWORK_CONFIG_OVERRIDE: options.networkConfigOverride
        ? JSON.stringify(options.networkConfigOverride)
        : '',
      ARGON_DEV_UPSTREAM_ROOT_DIR: options.rootDir,
    },
    stdio: ['ignore', logFd, logFd],
  });
  Fs.closeSync(logFd);

  if (!child.pid) throw new Error('Failed to start the dev upstream worker.');
  Fs.writeFileSync(paths.pidPath, `${child.pid}\n`);
  child.unref();

  try {
    await waitForWorkerReady(paths, child.pid);
  } catch (error) {
    Fs.rmSync(paths.pidPath, { force: true });
    Fs.rmSync(paths.readyPath, { force: true });
    throw error;
  }
  return child.pid;
}

export async function stopDevUpstreamWorker(rootDir: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const paths = getDevUpstreamWorkerPaths(rootDir);
  const pid = readRunningWorkerPid(paths.pidPath);
  if (!pid) {
    removeWorkerState(paths);
    return;
  }

  process.kill(pid, signal);
  const startedAt = Date.now();
  while (isProcessRunning(pid) && Date.now() - startedAt < WORKER_STOP_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
  removeWorkerState(paths);
}

export function stopDevUpstreamWorkerSync(rootDir: string): void {
  const paths = getDevUpstreamWorkerPaths(rootDir);
  const pid = readRunningWorkerPid(paths.pidPath);
  if (!pid) {
    removeWorkerState(paths);
    return;
  }

  process.kill(pid, 'SIGTERM');
  const startedAt = Date.now();
  while (isProcessRunning(pid) && Date.now() - startedAt < WORKER_STOP_TIMEOUT_MS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
  removeWorkerState(paths);
}

function readRunningWorkerPid(pidPath: string): number | undefined {
  let pid: number;
  try {
    pid = Number.parseInt(Fs.readFileSync(pidPath, 'utf8').trim(), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessRunning(pid)) return;
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForWorkerReady(paths: ReturnType<typeof getDevUpstreamWorkerPaths>, pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WORKER_START_TIMEOUT_MS) {
    if (Fs.existsSync(paths.readyPath)) return;
    if (!isProcessRunning(pid)) {
      throw new Error(`The dev upstream worker exited during startup. See ${paths.logPath}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The dev upstream worker did not become ready. See ${paths.logPath}.`);
}

function removeWorkerState(paths: ReturnType<typeof getDevUpstreamWorkerPaths>): void {
  Fs.rmSync(paths.pidPath, { force: true });
  Fs.rmSync(paths.readyPath, { force: true });
}
