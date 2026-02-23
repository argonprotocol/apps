import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DriverClient } from '../driver/client.ts';
import { type DriverServer, startDriverServer } from '../driver/server.ts';
import { getFlow, runFlow } from './index.ts';
import {
  resolveTestSessionIdentity,
  resolveTestSessionCommandEnv,
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';

const DEFAULT_APP_CONNECT_TIMEOUT_MS = 12 * 60_000;
const CLEANUP_PORT_WAIT_TIMEOUT_MS = 30_000;
const CLEANUP_PORT_POLL_INTERVAL_MS = 500;
const REQUIRED_LOCAL_DOCKER_PORTS = [3261];
const APP_IDS = ['com.argon.operations.local', 'com.argon.capital.local'] as const;
const FAILED_STEP_LOG_TAIL_LINES = 180;
const APP_STARTUP_READY_TIMEOUT_MS = 120_000;
const APP_STARTUP_READY_RETRY_DELAY_MS = 1_000;
const APP_STARTUP_READY_WAIT_TIMEOUT_MS = 15_000;
const APP_PROCESS_OUTPUT_MAX_LINES = 600;
const APP_PROCESS_OUTPUT_TAIL_LINES = 120;

export type E2ESessionMode = 'isolated' | 'stateful';
export type E2EFlowAppLogsMode = 'inherit' | 'quiet';

export interface IFlowSessionOptions {
  repoRoot?: string;
  useTestNetwork?: boolean;
  sessionName?: string;
  sessionMode?: E2ESessionMode;
  appLogsMode?: E2EFlowAppLogsMode;
}

export interface IFlowSession {
  run: (
    flowName: string,
    input?: Record<string, unknown>,
  ) => Promise<{ elapsedMs: number; data: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export async function createFlowSession(options: IFlowSessionOptions = {}): Promise<IFlowSession> {
  const repoRoot = getRepoRoot(options);
  const sessionMode = options.sessionMode ?? resolveFlowSessionMode(process.env.E2E_SESSION_MODE);
  const useTestNetwork = options.useTestNetwork ?? process.env.E2E_USE_TEST_NETWORK === '1';
  const appLogsMode = options.appLogsMode ?? resolveFlowSessionAppLogsMode(process.env.E2E_FLOW_APP_LOGS);
  if (sessionMode === 'stateful' && useTestNetwork) {
    throw new Error('[E2E] sessionMode=stateful requires useTestNetwork=false (test-network mode always resets).');
  }
  const shouldRunCleanup = sessionMode === 'isolated';
  const appProcessOutput = createAppProcessOutputTracker(appLogsMode);

  const driverServer: DriverServer = await startDriverServer();
  const driver = new DriverClient(driverServer.url);
  console.info(`[E2E] Driver session ${driverServer.session}`);
  let devDockerProcess: ChildProcess | null = null;
  let testNetwork: StartedArgonTestNetwork | null = null;
  let closed = false;
  const previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
  const previousNetworkConfigOverride = process.env.ARGON_NETWORK_CONFIG_OVERRIDE;

  const defaultSessionName = options.sessionName || 'e2e';
  const sessionIdentity = resolveTestSessionIdentity({
    fallbackSessionName: defaultSessionName,
  });
  const appInstanceName = sessionIdentity.appInstanceName || sessionIdentity.sessionName;
  const appPort = await chooseSessionPort(sessionIdentity.appInstancePort);
  const { composeProjectName, appEnv: commandEnv } = resolveTestSessionCommandEnv({
    baseEnv: process.env,
    fallbackSessionName: defaultSessionName,
    appPort,
  });
  const cleanupEnv: NodeJS.ProcessEnv = { ...commandEnv };
  const tauriEnv: NodeJS.ProcessEnv = {
    ...commandEnv,
    ARGON_DRIVER_WS: driverServer.url,
    ARGON_E2E_HEADLESS: process.env.ARGON_E2E_HEADLESS?.trim() || '0',
    ARGON_APP_ENABLE_AUTOUPDATE: '0',
  };
  try {
    if (useTestNetwork) {
      if (shouldRunCleanup) {
        // Reset prior local VM/docker state for this session before bringing up the test network.
        runCleanDevDocker(repoRoot, cleanupEnv, 'startup');
        await ensurePortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'startup');
      }

      testNetwork = await startArgonTestNetwork(sessionIdentity.sessionName, {
        profiles: ['price-oracle'],
        registerTeardown: false,
        composeProjectName,
      });
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(testNetwork.networkConfigOverride);
      process.env.ARGON_NETWORK_CONFIG_OVERRIDE = tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
      const composeEnv = testNetwork.composeEnv;

      // Keep helper commands (btc-cli, funding RPC) pointed at the same ephemeral compose project.
      process.env.COMPOSE_PROJECT_NAME = composeEnv.COMPOSE_PROJECT_NAME;

      devDockerProcess = spawn('yarn', ['tauri:dev:docker'], createAppSpawnOptions(repoRoot, tauriEnv, appLogsMode));
    } else {
      const appCommand = sessionMode === 'stateful' ? ['tauri:dev:docker'] : ['dev:docker'];
      devDockerProcess = spawn('yarn', appCommand, createAppSpawnOptions(repoRoot, tauriEnv, appLogsMode));
    }
    attachAppProcessOutput(devDockerProcess, appProcessOutput);
  } catch (error) {
    driver.close();
    await driverServer.close();
    if (testNetwork) {
      await testNetwork.stop();
    }
    if (shouldRunCleanup) {
      runCleanDevDocker(repoRoot, cleanupEnv, 'startup-error');
    }
    restoreComposeProjectName(previousComposeProjectName);
    restoreNetworkConfigOverride(previousNetworkConfigOverride);
    throw error;
  }

  devDockerProcess.once('exit', code => {
    if (code !== 0 && !closed) {
      console.error(`[E2E] dev:docker exited with code ${code}`);
      printAppProcessOutputTail(appProcessOutput, 'process-exit');
    }
  });

  try {
    await driver.connect();
    await waitForAppConnection(driver, devDockerProcess, DEFAULT_APP_CONNECT_TIMEOUT_MS);
    await waitForInitialUiReady(driver, devDockerProcess, APP_STARTUP_READY_TIMEOUT_MS);
  } catch (error) {
    printAppProcessOutputTail(appProcessOutput, 'connect-error');
    closed = true;
    driver.close();
    await stopChild(devDockerProcess);
    if (testNetwork) {
      await testNetwork.stop();
    }
    if (shouldRunCleanup) {
      runCleanDevDocker(repoRoot, cleanupEnv, 'connect-error');
    }
    await driverServer.close();
    restoreComposeProjectName(previousComposeProjectName);
    restoreNetworkConfigOverride(previousNetworkConfigOverride);
    throw error;
  }

  return {
    run: async (flowName, input = {}) => {
      if (!getFlow(flowName)) {
        throw new Error(`Unknown flow '${flowName}'`);
      }
      const startedAt = Date.now();
      try {
        const result = await runFlow(driver, flowName, { input });
        return {
          elapsedMs: Date.now() - startedAt,
          data: result.data,
        };
      } catch (error) {
        await printInstallFailureLogs(sessionIdentity.composeNetwork, appInstanceName, flowName, error);
        printAppProcessOutputTail(appProcessOutput, 'flow-failure');
        const frontendErrors = driver.getFrontendErrors();
        if (frontendErrors.length > 0) {
          console.error('[E2E] Frontend errors captured during flow:');
          for (const [index, frontendError] of frontendErrors.entries()) {
            console.error(`[E2E] frontend.error #${index + 1}: ${frontendError}`);
          }
        }
        throw error;
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        driver.close();
        await stopChild(devDockerProcess);
        if (testNetwork) {
          await testNetwork.stop();
        }
        if (shouldRunCleanup) {
          runCleanDevDocker(repoRoot, cleanupEnv, 'session-close');
          await ensurePortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'session-close').catch(error => {
            console.warn(`[E2E] ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        await driverServer.close();
      } finally {
        restoreComposeProjectName(previousComposeProjectName);
        restoreNetworkConfigOverride(previousNetworkConfigOverride);
      }
    },
  };
}

function getAppConfigBaseDir(): string {
  if (process.platform === 'darwin') {
    return Path.join(process.env.HOME ?? '', 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || Path.join(process.env.HOME ?? '', 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || Path.join(process.env.HOME ?? '', '.config');
}

function getServerLogDirectories(networkName: string, instanceName: string): string[] {
  const appConfigBaseDir = getAppConfigBaseDir();
  return APP_IDS.map(appId =>
    Path.join(appConfigBaseDir, appId, networkName, instanceName, 'virtual-machine', 'app', 'logs'),
  );
}

function tailText(text: string, lineLimit: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  return lines.slice(Math.max(0, lines.length - lineLimit)).join('\n');
}

async function printInstallFailureLogs(
  networkName: string,
  instanceName: string,
  flowName: string,
  error: unknown,
): Promise<void> {
  const baseLogDirs = getServerLogDirectories(networkName, instanceName);
  const existingLogDirs = baseLogDirs.filter(path => existsSync(path));
  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error('[E2E] ==========================================');
  console.error('[E2E] Flow failed; fetching server install logs before teardown');
  console.error(`[E2E] Flow: ${flowName}`);
  console.error(`[E2E] Error: ${errorMessage}`);

  if (!existingLogDirs.length) {
    console.warn('[E2E] No local server log directory found for this session.');
    return;
  }

  for (const logDir of existingLogDirs) {
    console.error(`[E2E] Reading server logs from ${logDir}`);
    let entries: string[];
    try {
      entries = readdirSync(logDir);
    } catch (errorReadDir) {
      console.warn(`[E2E] Unable to read ${logDir}: ${(errorReadDir as Error).message}`);
      continue;
    }

    const failedFiles = entries.filter(name => /\.Failed$/.test(name)).sort((a, b) => a.localeCompare(b));
    if (failedFiles.length === 0) {
      console.warn(`[E2E] No .Failed install step files found under ${logDir}`);
      const finishedFiles = entries.filter(name => /\.Finished$/i.test(name)).sort((a, b) => a.localeCompare(b));
      const logFiles = entries.filter(name => /\.log$/i.test(name)).sort((a, b) => a.localeCompare(b));
      const fallbackTargets = [...new Set([...finishedFiles.slice(-2), ...logFiles.slice(-2)])];

      if (fallbackTargets.length === 0) {
        console.warn(`[E2E] No install log artifacts found under ${logDir}`);
        continue;
      }

      for (const fallbackFile of fallbackTargets) {
        const fallbackPath = Path.join(logDir, fallbackFile);
        console.error(`[E2E] --- Recent artifact: ${fallbackFile} ---`);
        try {
          const fallbackContents = readFileSync(fallbackPath, 'utf8');
          console.error(tailText(fallbackContents, FAILED_STEP_LOG_TAIL_LINES));
        } catch (logError) {
          console.warn(`[E2E] Could not read ${fallbackPath}: ${(logError as Error).message}`);
        }
      }
      continue;
    }

    for (const failedFile of failedFiles) {
      const stepFilePath = Path.join(logDir, failedFile);
      const baseName = failedFile.replace(/^step-/, '').replace(/\.Failed$/, '');
      const logFilePath = Path.join(logDir, `step-${baseName}.log`);
      const finishedFilePath = Path.join(logDir, `step-${baseName}.Finished`);

      console.error(`[E2E] --- Failed step: ${baseName} ---`);
      try {
        const failedContents = readFileSync(stepFilePath, 'utf8');
        console.error(tailText(failedContents, FAILED_STEP_LOG_TAIL_LINES));
      } catch (logError) {
        console.warn(`[E2E] Could not read ${stepFilePath}: ${(logError as Error).message}`);
      }

      if (existsSync(logFilePath)) {
        try {
          const logContents = readFileSync(logFilePath, 'utf8');
          console.error(`[E2E] tail(${FAILED_STEP_LOG_TAIL_LINES}) step-${baseName}.log`);
          console.error(tailText(logContents, FAILED_STEP_LOG_TAIL_LINES));
        } catch (logError) {
          console.warn(`[E2E] Could not read ${logFilePath}: ${(logError as Error).message}`);
        }
      }

      if (existsSync(finishedFilePath)) {
        try {
          const finishContents = readFileSync(finishedFilePath, 'utf8');
          console.error(`[E2E] step-${baseName}.Finished`);
          console.error(tailText(finishContents, FAILED_STEP_LOG_TAIL_LINES));
        } catch (logError) {
          console.warn(`[E2E] Could not read ${finishedFilePath}: ${(logError as Error).message}`);
        }
      }
    }
  }
  console.error('[E2E] ==========================================');
}

export function resolveFlowSessionMode(value: string | undefined): E2ESessionMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'stateful') {
    return 'stateful';
  }
  return 'isolated';
}

export function resolveFlowSessionAppLogsMode(value: string | undefined): E2EFlowAppLogsMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'quiet') {
    return 'quiet';
  }
  return 'inherit';
}

function getRepoRoot(options: IFlowSessionOptions): string {
  if (options.repoRoot) return options.repoRoot;
  const scriptDir = Path.dirname(fileURLToPath(import.meta.url));
  return Path.resolve(scriptDir, '..', '..');
}

function createAppSpawnOptions(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  appLogsMode: E2EFlowAppLogsMode,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | ['ignore', 'pipe', 'pipe'];
  detached: boolean;
} {
  return {
    cwd: repoRoot,
    env,
    stdio: appLogsMode === 'quiet' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: process.platform !== 'win32',
  };
}

interface IAppProcessOutputTracker {
  appLogsMode: E2EFlowAppLogsMode;
  lines: string[];
  pendingStdout: string;
  pendingStderr: string;
}

function createAppProcessOutputTracker(appLogsMode: E2EFlowAppLogsMode): IAppProcessOutputTracker {
  return {
    appLogsMode,
    lines: [],
    pendingStdout: '',
    pendingStderr: '',
  };
}

function attachAppProcessOutput(child: ChildProcess, tracker: IAppProcessOutputTracker): void {
  if (tracker.appLogsMode !== 'quiet') return;
  attachAppOutputStream(child.stdout, 'stdout', tracker);
  attachAppOutputStream(child.stderr, 'stderr', tracker);
}

function attachAppOutputStream(
  stream: NodeJS.ReadableStream | null,
  source: 'stdout' | 'stderr',
  tracker: IAppProcessOutputTracker,
): void {
  if (!stream) return;
  if (typeof (stream as { setEncoding?: (encoding: string) => void }).setEncoding === 'function') {
    (stream as { setEncoding: (encoding: string) => void }).setEncoding('utf8');
  }
  stream.on('data', chunk => {
    appendAppOutputChunk(tracker, source, String(chunk ?? ''));
  });
}

function appendAppOutputChunk(tracker: IAppProcessOutputTracker, source: 'stdout' | 'stderr', rawChunk: string): void {
  if (!rawChunk) return;
  const normalizedChunk = rawChunk.replace(/\r\n?/g, '\n');
  const previous = source === 'stdout' ? tracker.pendingStdout : tracker.pendingStderr;
  const combined = `${previous}${normalizedChunk}`;
  const lines = combined.split('\n');
  const trailing = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    pushAppOutputLine(tracker, `[${source}] ${line}`);
  }
  if (source === 'stdout') {
    tracker.pendingStdout = trailing;
  } else {
    tracker.pendingStderr = trailing;
  }
}

function pushAppOutputLine(tracker: IAppProcessOutputTracker, line: string): void {
  tracker.lines.push(line);
  if (tracker.lines.length > APP_PROCESS_OUTPUT_MAX_LINES) {
    tracker.lines.splice(0, tracker.lines.length - APP_PROCESS_OUTPUT_MAX_LINES);
  }
}

function collectAppOutputTail(tracker: IAppProcessOutputTracker, lineLimit: number): string[] {
  const lines = [...tracker.lines];
  if (tracker.pendingStdout.trim().length > 0) {
    lines.push(`[stdout] ${tracker.pendingStdout.trimEnd()}`);
  }
  if (tracker.pendingStderr.trim().length > 0) {
    lines.push(`[stderr] ${tracker.pendingStderr.trimEnd()}`);
  }
  if (lines.length <= lineLimit) return lines;
  return lines.slice(lines.length - lineLimit);
}

function printAppProcessOutputTail(tracker: IAppProcessOutputTracker, reason: string): void {
  if (tracker.appLogsMode !== 'quiet') return;
  const tail = collectAppOutputTail(tracker, APP_PROCESS_OUTPUT_TAIL_LINES);
  if (tail.length === 0) return;
  console.error(`[E2E] Recent app output (${reason}):`);
  for (const line of tail) {
    console.error(`[E2E] ${line}`);
  }
}

async function waitForAppConnection(driver: DriverClient, appProcess: ChildProcess, timeoutMs: number): Promise<void> {
  console.info(`[E2E] Waiting for app connection (timeout ${timeoutMs}ms)`);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      appProcess.off('exit', onExit);
      callback();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() =>
        reject(
          new Error(
            `[E2E] App process exited before driver app connection (code=${String(code)}, signal=${String(signal)})`,
          ),
        ),
      );
    };

    timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`Timed out waiting for app connection after ${timeoutMs}ms (driver ${driver.getUrl()})`)),
        ),
      timeoutMs,
    );

    appProcess.once('exit', onExit);
    void driver
      .waitForApp()
      .then(() => finish(resolve))
      .catch(error => finish(() => reject(error)));
  });
}

async function waitForInitialUiReady(driver: DriverClient, appProcess: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(
        `[E2E] App process exited before initial UI readiness check (code=${String(appProcess.exitCode)}, signal=${String(appProcess.signalCode)})`,
      );
    }

    attempt += 1;
    try {
      await driver.command('ui.waitFor', {
        selector: '#app',
        state: 'exists',
        timeoutMs: APP_STARTUP_READY_WAIT_TIMEOUT_MS,
      });
      if (attempt > 1) {
        console.info(`[E2E] App became ready after startup retry (attempt=${attempt})`);
      }
      return;
    } catch (error) {
      if (!isRetryableStartupDriverError(error)) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, timeoutMs - elapsedMs);
      console.warn(
        `[E2E] Initial UI readiness command failed during app startup (attempt=${attempt}, remainingMs=${remainingMs}); retrying`,
      );
      await sleep(APP_STARTUP_READY_RETRY_DELAY_MS);
    }
  }

  throw new Error(`[E2E] Timed out waiting for initial UI readiness after ${timeoutMs}ms`);
}

function isRetryableStartupDriverError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('[app_disconnected]') || error.message.includes('[app_not_connected]');
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalChild(child, 'SIGINT');
  if (await waitForExit(child, 20_000)) return;

  signalChild(child, 'SIGTERM');
  if (await waitForExit(child, 10_000)) return;

  signalChild(child, 'SIGKILL');
  await waitForExit(child, 5_000);
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;

  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct child signaling if process-group signaling fails.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Process may already be gone between checks.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function restoreComposeProjectName(previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env.COMPOSE_PROJECT_NAME;
    return;
  }
  process.env.COMPOSE_PROJECT_NAME = previousValue;
}

function restoreNetworkConfigOverride(previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env.ARGON_NETWORK_CONFIG_OVERRIDE;
    return;
  }
  process.env.ARGON_NETWORK_CONFIG_OVERRIDE = previousValue;
}

function runCleanDevDocker(repoRoot: string, env: NodeJS.ProcessEnv, reason: string): void {
  try {
    execFileSync('yarn', ['clean:dev:docker'], {
      cwd: repoRoot,
      env,
      shell: true,
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn(`[E2E] clean:dev:docker failed (${reason}): ${(error as Error).message}`);
  }
}

async function ensurePortsReleased(
  ports: number[],
  reason: string,
  timeoutMs: number = CLEANUP_PORT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const blocked = await getBlockedPorts(ports);
    if (blocked.length === 0) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Required local port(s) still in use after cleanup (${reason}): ${blocked.join(', ')} (waited ${timeoutMs}ms)`,
      );
    }
    await sleep(CLEANUP_PORT_POLL_INTERVAL_MS);
  }
}

async function getBlockedPorts(ports: number[]): Promise<number[]> {
  const checks = await Promise.all(ports.map(async port => ({ port, free: await isPortAvailable(port) })));
  return checks.filter(x => !x.free).map(x => x.port);
}

async function chooseSessionPort(configuredPortRaw: string | undefined): Promise<number> {
  const configuredPort = parsePort(configuredPortRaw);
  if (configuredPort && (await isPortAvailable(configuredPort))) {
    return configuredPort;
  }
  return reserveEphemeralPort();
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve an ephemeral app port')));
        return;
      }
      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
