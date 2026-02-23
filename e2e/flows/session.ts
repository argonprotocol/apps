import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DriverClient } from '../driver/client.js';
import { type DriverServer, startDriverServer } from '../driver/server.js';
import { getFlow, runFlow } from './index.js';
import {
  resolveTestSessionIdentity,
  resolveTestSessionCommandEnv,
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';

const DEFAULT_APP_CONNECT_TIMEOUT_MS = 12 * 60_000;
const CLEANUP_PORT_WAIT_TIMEOUT_MS = 30_000;
const CLEANUP_PORT_POLL_INTERVAL_MS = 500;
const REQUIRED_LOCAL_DOCKER_PORTS = [3261];
const APP_IDS = ['com.argon.operations.local', 'com.argon.capital.local'] as const;
const FAILED_STEP_LOG_TAIL_LINES = 180;

export interface FlowSessionOptions {
  repoRoot?: string;
  useTestNetwork?: boolean;
  sessionName?: string;
}

export interface FlowSession {
  run: (flowName: string, input?: Record<string, unknown>) => Promise<{ elapsedMs: number }>;
  close: () => Promise<void>;
}

export async function createFlowSession(options: FlowSessionOptions = {}): Promise<FlowSession> {
  const repoRoot = getRepoRoot(options);
  const useTestNetwork = options.useTestNetwork ?? process.env.E2E_USE_TEST_NETWORK === '1';

  const driverServer: DriverServer = await startDriverServer();
  const driver = new DriverClient(driverServer.url);
  console.info(`[E2E] Driver session ${driverServer.session}`);
  let devDockerProcess: ChildProcess | null = null;
  let testNetwork: StartedArgonTestNetwork | null = null;
  let closed = false;
  const previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;

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
      // Reset prior local VM/docker state for this session before bringing up the test network.
      runCleanDevDocker(repoRoot, cleanupEnv, 'startup');
      await ensurePortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'startup');

      testNetwork = await startArgonTestNetwork(sessionIdentity.sessionName, {
        profiles: ['price-oracle'],
        registerTeardown: false,
        composeProjectName,
      });
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(testNetwork.networkConfigOverride);
      const composeEnv = testNetwork.composeEnv;

      // Keep helper commands (btc-cli, funding RPC) pointed at the same ephemeral compose project.
      process.env.COMPOSE_PROJECT_NAME = composeEnv.COMPOSE_PROJECT_NAME;

      devDockerProcess = spawn('yarn', ['tauri:dev:docker'], {
        cwd: repoRoot,
        env: tauriEnv,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
    } else {
      devDockerProcess = spawn('yarn', ['dev:docker'], {
        cwd: repoRoot,
        env: tauriEnv,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
    }
  } catch (error) {
    driver.close();
    await driverServer.close();
    if (testNetwork) {
      await testNetwork.stop();
    }
    runCleanDevDocker(repoRoot, cleanupEnv, 'startup-error');
    restoreComposeProjectName(previousComposeProjectName);
    throw error;
  }

  devDockerProcess.once('exit', code => {
    if (code !== 0 && !closed) {
      console.error(`[E2E] dev:docker exited with code ${code}`);
    }
  });

  try {
    await driver.connect();
    await waitForAppConnection(driver, devDockerProcess, DEFAULT_APP_CONNECT_TIMEOUT_MS);
  } catch (error) {
    closed = true;
    driver.close();
    await stopChild(devDockerProcess);
    if (testNetwork) {
      await testNetwork.stop();
    }
    runCleanDevDocker(repoRoot, cleanupEnv, 'connect-error');
    await driverServer.close();
    restoreComposeProjectName(previousComposeProjectName);
    throw error;
  }

  return {
    run: async (flowName, input = {}) => {
      if (!getFlow(flowName)) {
        throw new Error(`Unknown flow '${flowName}'`);
      }
      const startedAt = Date.now();
      try {
        await runFlow(driver, flowName, { input });
      } catch (error) {
        await printInstallFailureLogs(sessionIdentity.composeNetwork, appInstanceName, flowName, error);
        const frontendErrors = driver.getFrontendErrors();
        if (frontendErrors.length > 0) {
          console.error('[E2E] Frontend errors captured during flow:');
          for (const [index, frontendError] of frontendErrors.entries()) {
            console.error(`[E2E] frontend.error #${index + 1}: ${frontendError}`);
          }
        }
        throw error;
      }
      return {
        elapsedMs: Date.now() - startedAt,
      };
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
        runCleanDevDocker(repoRoot, cleanupEnv, 'session-close');
        await ensurePortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'session-close').catch(error => {
          console.warn(`[E2E] ${error instanceof Error ? error.message : String(error)}`);
        });
        await driverServer.close();
      } finally {
        restoreComposeProjectName(previousComposeProjectName);
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

export function getDefaultFlowInput(flowName: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (flowName === 'miningOnboarding') {
    const input: Record<string, unknown> = {
      serverTab: getOptionalEnv(env, 'MINING_SERVER_TAB') ?? 'local',
    };
    const startingBidArgons = getOptionalEnv(env, 'MINING_STARTING_BID_ARGONS');
    const maximumBidArgons = getOptionalEnv(env, 'MINING_MAXIMUM_BID_ARGONS');
    const fundingArgons = getOptionalEnv(env, 'MINING_FUNDING_ARGONS');

    if (startingBidArgons) input.startingBidArgons = startingBidArgons;
    if (maximumBidArgons) input.maximumBidArgons = maximumBidArgons;
    if (fundingArgons) input.fundingArgons = fundingArgons;
    return input;
  }

  if (flowName === 'vaultingOnboarding') {
    const input: Record<string, unknown> = {};
    const extraFundingArgons = getOptionalEnv(env, 'VAULTING_EXTRA_FUNDING_ARGONS');
    if (extraFundingArgons) input.extraFundingArgons = extraFundingArgons;
    return input;
  }

  return {};
}

function getOptionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function getRepoRoot(options: FlowSessionOptions): string {
  if (options.repoRoot) return options.repoRoot;
  const scriptDir = Path.dirname(fileURLToPath(import.meta.url));
  return Path.resolve(scriptDir, '..', '..');
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
