import { execFileSync, spawn } from 'node:child_process';
import Crypto from 'node:crypto';
import Fs, { type Stats } from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { INetworkConfigOverride } from '@argonprotocol/apps-core';
import type { IDevEthereumConfig, IStartDevEthereumResult } from '../devEthereum.ts';

const WORKER_START_TIMEOUT_MS = 15 * 60_000;
const WORKER_STOP_TIMEOUT_MS = 10_000;

export interface IDevUpstreamWorkerStartOptions {
  archiveUrl: string;
  devEthereum?: Pick<IStartDevEthereumResult, 'serverBeaconApiUrl' | 'serverExecutionRpcUrl' | 'usdcTokenAddress'>;
  devEthereumConfig?: Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis'>;
  env: NodeJS.ProcessEnv;
  executionRpcUrl?: string;
  networkConfigOverride?: INetworkConfigOverride;
  devUpstreamDir: string;
  workerPath?: string;
}

export function resolveDevUpstreamDir(env: NodeJS.ProcessEnv = process.env): string {
  const configuredDir = env.ARGON_DEV_UPSTREAM_DIR?.trim();
  if (configuredDir) return Path.resolve(configuredDir);

  const configuredInstanceDir = env.ARGON_APP_INSTANCE_DIR?.trim();
  if (configuredInstanceDir) return Path.join(configuredInstanceDir, 'dev-upstream');

  let appConfigDir: string;
  if (process.platform === 'darwin') {
    appConfigDir = Path.join(Os.homedir(), 'Library', 'Application Support');
  } else if (process.platform === 'win32') {
    appConfigDir = env.APPDATA || Path.join(Os.homedir(), 'AppData', 'Roaming');
  } else {
    appConfigDir = env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  }

  const network = env.ARGON_NETWORK_NAME?.trim() || 'dev-docker';
  const instance = env.ARGON_APP_INSTANCE?.trim().split(':')[0] || 'e2e';
  return Path.join(appConfigDir, 'com.argon.desktop.local', network, instance, 'dev-upstream');
}

export function getDevUpstreamWorkerPaths(devUpstreamDir: string) {
  return {
    logPath: Path.join(devUpstreamDir, 'operator-worker.log'),
    statePath: Path.join(devUpstreamDir, 'operator-worker.json'),
  };
}

export async function restartDevUpstreamWorker(options: IDevUpstreamWorkerStartOptions): Promise<number> {
  const paths = getDevUpstreamWorkerPaths(options.devUpstreamDir);
  const existingState = readWorkerState(paths.statePath);
  if (existingState && isOwnedWorkerRunning(existingState)) {
    await stopDevUpstreamWorker(options.devUpstreamDir);
  }

  Fs.mkdirSync(Path.dirname(paths.statePath), { recursive: true });
  Fs.rmSync(paths.statePath, { force: true });
  Fs.writeFileSync(paths.logPath, `[dev-upstream-worker] Starting new launch at ${new Date().toISOString()}\n`);

  const logFd = Fs.openSync(paths.logPath, 'a');
  const scriptsDir = Path.dirname(fileURLToPath(import.meta.url));
  const workerPath = options.workerPath ?? Path.join(scriptsDir, 'devUpstreamWorker.ts');
  const launchId = Crypto.randomUUID();
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.resolve('tsx/cli')), workerPath, `--launch-id=${launchId}`],
    {
      cwd: Path.resolve(scriptsDir, '..', '..'),
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
        ARGON_DEV_UPSTREAM_LAUNCH_ID: launchId,
        ARGON_DEV_UPSTREAM_DIR: options.devUpstreamDir,
      },
      stdio: ['ignore', logFd, logFd],
    },
  );
  Fs.closeSync(logFd);

  if (!child.pid) throw new Error('Failed to start the dev upstream worker.');
  writeWorkerState(paths.statePath, { pid: child.pid, ready: false, launchId });
  child.unref();

  try {
    await waitForWorkerReady(paths, child.pid);
  } catch (error) {
    await terminateWorker(child.pid);
    removeWorkerState(paths);
    throw error;
  }
  return child.pid;
}

export async function stopDevUpstreamWorker(devUpstreamDir: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const paths = getDevUpstreamWorkerPaths(devUpstreamDir);
  const state = readWorkerState(paths.statePath);
  if (state && isOwnedWorkerRunning(state)) {
    await terminateWorker(state.pid, signal);
  }
  removeWorkerState(paths);
}

export function stopDevUpstreamWorkerSync(devUpstreamDir: string): void {
  const paths = getDevUpstreamWorkerPaths(devUpstreamDir);
  const state = readWorkerState(paths.statePath);
  if (state && isOwnedWorkerRunning(state)) {
    terminateWorkerSync(state.pid);
  }
  removeWorkerState(paths);
}

export function setDevUpstreamWorkerReady(
  ready: boolean,
  devUpstreamDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
  const state = readWorkerState(statePath);
  if (
    !state ||
    state.launchId !== env.ARGON_DEV_UPSTREAM_LAUNCH_ID ||
    (state.pid !== process.pid && state.pid !== process.ppid)
  ) {
    return;
  }
  writeWorkerState(statePath, { ...state, ready });
}

export function watchAppInstanceDirectory(instanceDir: string, onRemoved: VoidFunction): { close(): void } {
  let instanceInode: number;
  try {
    instanceInode = Fs.statSync(instanceDir).ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const releaseTimer = setTimeout(onRemoved, 0);
    releaseTimer.unref();
    return { close: () => clearTimeout(releaseTimer) };
  }
  let isRemoved = false;

  const remove = () => {
    if (isRemoved) return;
    isRemoved = true;
    Fs.unwatchFile(instanceDir, checkDirectory);
    onRemoved();
  };
  const checkDirectory = (current: Stats) => {
    if (current.nlink === 0 || (instanceInode !== 0 && current.ino !== instanceInode)) remove();
  };

  Fs.watchFile(instanceDir, { interval: 250, persistent: false }, checkDirectory);

  return {
    close: () => Fs.unwatchFile(instanceDir, checkDirectory),
  };
}

async function terminateWorker(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  signalProcessTree(pid, signal);
  if (process.platform === 'win32') return;

  const startedAt = Date.now();
  while (isWorkerGroupRunning(pid) && Date.now() - startedAt < WORKER_STOP_TIMEOUT_MS) {
    await delay(50);
  }
  if (isWorkerGroupRunning(pid)) signalProcessTree(pid, 'SIGKILL');
}

function terminateWorkerSync(pid: number): void {
  signalProcessTree(pid, 'SIGTERM');
  if (process.platform === 'win32') return;

  const startedAt = Date.now();
  while (isWorkerGroupRunning(pid) && Date.now() - startedAt < WORKER_STOP_TIMEOUT_MS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (isWorkerGroupRunning(pid)) signalProcessTree(pid, 'SIGKILL');
}

function readWorkerState(statePath: string): IDevUpstreamWorkerState | undefined {
  try {
    const state = JSON.parse(Fs.readFileSync(statePath, 'utf8')) as Partial<IDevUpstreamWorkerState>;
    if (
      !Number.isSafeInteger(state.pid) ||
      (state.pid ?? 0) <= 0 ||
      typeof state.ready !== 'boolean' ||
      typeof state.launchId !== 'string'
    ) {
      return;
    }
    return state as IDevUpstreamWorkerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isWorkerGroupRunning(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isOwnedWorkerRunning(state: IDevUpstreamWorkerState): boolean {
  return isProcessRunning(state.pid) && getWorkerCommand(state.pid)?.includes(`--launch-id=${state.launchId}`) === true;
}

function getWorkerCommand(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (error) {
      if (isProcessRunning(pid)) throw error;
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForWorkerReady(paths: ReturnType<typeof getDevUpstreamWorkerPaths>, pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WORKER_START_TIMEOUT_MS) {
    const state = readWorkerState(paths.statePath);
    if (state?.pid === pid && state.ready && isOwnedWorkerRunning(state)) return;
    if (!isProcessRunning(pid)) {
      throw new Error(`The dev upstream worker exited during startup. See ${paths.logPath}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The dev upstream worker did not become ready. See ${paths.logPath}.`);
}

function removeWorkerState(paths: ReturnType<typeof getDevUpstreamWorkerPaths>): void {
  Fs.rmSync(paths.statePath, { force: true });
}

function writeWorkerState(statePath: string, state: IDevUpstreamWorkerState): void {
  Fs.writeFileSync(statePath, JSON.stringify(state));
}

interface IDevUpstreamWorkerState {
  pid: number;
  ready: boolean;
  launchId: string;
}
