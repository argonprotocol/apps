import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chooseAvailablePort, delay, isPortAvailable } from '../scripts/utils.ts';
import { AppProcess } from './AppProcess.ts';
import type { AppLogsMode } from './AppProcessOutput.ts';
import { AppSessionDiagnostics } from './AppSessionDiagnostics.ts';
import { DriverClient } from './driver/client.ts';
import { type DriverServer, startDriverServer } from './driver/server.ts';
import type { IAccountHistoryRecoveryReport } from 'src-vue/e2e/AccountHistoryRecovery.ts';
import type { IAppQueryFn } from 'src-vue/interfaces/IAppQueryRefs.ts';
import {
  resolveTestSessionIdentity,
  resolveTestSessionCommandEnv,
  resolveTestSessionDataDir,
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import {
  resolveDevUpstreamDir,
  restartDevUpstreamWorker,
  stopDevUpstreamWorker,
} from './scripts/devUpstreamProcess.ts';

const DEFAULT_APP_CONNECT_TIMEOUT_MS = 12 * 60_000;
const CLEANUP_PORT_WAIT_TIMEOUT_MS = 30_000;
const CLEANUP_PORT_POLL_INTERVAL_MS = 500;
const REQUIRED_LOCAL_DOCKER_PORTS = [3261];
const APP_STARTUP_READY_TIMEOUT_MS = 120_000;
const LOCAL_APP_CONFIG_ID = 'com.argon.desktop.local';
const execFileAsync = promisify(execFile);

export type E2ESessionMode = 'isolated' | 'stateful';

export interface AppSessionOptions {
  repoRoot?: string;
  tauriDevConfig?: {
    capabilities: string[];
    beforeDevCommand?: string;
  };
  useTestNetwork?: boolean;
  sessionName?: string;
  sessionMode?: E2ESessionMode;
  appLogsMode?: AppLogsMode;
  appEnv?: NodeJS.ProcessEnv;
  autoEnableOperations?: boolean;
  focusAppWindow?: boolean;
  useDevUpstream?: boolean;
}

export class AppSession {
  public static async start(this: void, options: AppSessionOptions = {}): Promise<AppSession> {
    const session = new AppSession(options);
    await session.initialize();
    return session;
  }

  public static resolveMode(value: string | undefined): E2ESessionMode {
    return value?.trim().toLowerCase() === 'stateful' ? 'stateful' : 'isolated';
  }

  public static resolveLogsMode(value: string | undefined): AppLogsMode {
    return value?.trim().toLowerCase() === 'quiet' ? 'quiet' : 'inherit';
  }

  public static resolveInstanceDirectory(args: { networkName: string; instanceName: string }): string {
    const { networkName, instanceName } = args;
    const identity = resolveTestSessionIdentity({ networkName, sessionName: instanceName });
    return AppSessionDiagnostics.getInstanceDirectory(
      LOCAL_APP_CONFIG_ID,
      identity.composeNetwork,
      identity.appInstanceName || identity.sessionName,
    );
  }

  protected driver!: DriverClient;
  protected sessionData: Record<string, unknown> = {};
  private appProcess!: AppProcess;
  private cleanupEnv!: NodeJS.ProcessEnv;
  private diagnostics!: AppSessionDiagnostics;
  private devUpstreamDir?: string;
  private driverServer!: DriverServer;
  private previousComposeProjectName?: string;
  private previousDevEthereumRuntimeStateDir?: string;
  private previousDevUpstreamDir?: string;
  private previousNetworkConfigOverride?: string;
  private repoRoot!: string;
  private shouldRunCleanup = false;
  private testNetwork: StartedArgonTestNetwork | null = null;
  private unexpectedExitListener!: (code: number | null) => void;
  private closed = false;
  private instanceDirectory!: string;

  protected constructor(private readonly options: AppSessionOptions) {}

  public get appInstanceDirectory(): string {
    return this.instanceDirectory;
  }

  public get archiveUrl(): string {
    return String(this.sessionData.sessionArchiveUrl);
  }

  public async checkpointDatabase(): Promise<void> {
    await this.driver.command('app.checkpointDatabase', { timeoutMs: 30_000 });
  }

  public async resumeDatabaseWrites(): Promise<void> {
    await this.driver.command('app.resumeDatabaseWrites');
  }

  public async waitForReady(timeoutMs: number = APP_STARTUP_READY_TIMEOUT_MS): Promise<void> {
    await this.driver.command('app.waitForReady', { timeoutMs });
  }

  public async recoverAccountHistory(
    throughBlock: number,
    timeoutMs = 300_000,
  ): Promise<IAccountHistoryRecoveryReport> {
    const recoverHistory: IAppQueryFn<IAccountHistoryRecoveryReport, { throughBlock: number }> = (refs, args) =>
      refs.accountHistoryRecovery.recoverThrough(args.throughBlock);
    const result = await this.driver.command<{ value?: IAccountHistoryRecoveryReport }>('command.queryApp', {
      fn: recoverHistory.toString(),
      args: { throughBlock },
      timeoutMs,
    });
    if (!result.value) {
      throw new Error(`Account history did not finish recovery through block ${throughBlock.toLocaleString()}`);
    }
    return result.value;
  }

  public async loadInstance(name: string): Promise<void> {
    const reloadMarker = this.driver.getAppReloadMarker();
    await this.driver.command('app.loadInstance', { name, timeoutMs: 30_000 });
    await this.driver.waitForApp(reloadMarker + 1);
    await this.appProcess.waitForUiReady(this.driver, APP_STARTUP_READY_TIMEOUT_MS);
    this.instanceDirectory = Path.join(Path.dirname(this.instanceDirectory), name);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.appProcess.child.removeListener('exit', this.unexpectedExitListener);
      this.driver.close();
      await this.appProcess.stop();
      if (this.devUpstreamDir) {
        await stopDevUpstreamWorker(this.devUpstreamDir).catch(error => {
          console.warn(`[E2E] Failed to stop dev upstream worker: ${(error as Error).message}`);
        });
      }
      if (this.testNetwork) {
        await this.testNetwork.stop();
      }
      if (this.shouldRunCleanup) {
        AppSession.cleanDevDocker(this.repoRoot, this.cleanupEnv, 'session-close');
        await AppSession.waitForPortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'session-close').catch(error => {
          console.warn(`[E2E] ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await this.driverServer.close();
    } finally {
      AppSession.restoreProcessEnv('COMPOSE_PROJECT_NAME', this.previousComposeProjectName);
      AppSession.restoreProcessEnv('ARGON_NETWORK_CONFIG_OVERRIDE', this.previousNetworkConfigOverride);
      AppSession.restoreProcessEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', this.previousDevEthereumRuntimeStateDir);
      AppSession.restoreProcessEnv('ARGON_DEV_UPSTREAM_DIR', this.previousDevUpstreamDir);
      this.appProcess.output.close();
    }
  }

  protected async reportFlowFailure(flowName: string, error: unknown): Promise<void> {
    await this.diagnostics.printFailure(flowName, error);
    this.appProcess.output.printTail('flow-failure');
    const frontendErrors = this.driver.getFrontendErrors();
    if (frontendErrors.length > 0) {
      console.error('[E2E] Frontend errors captured during flow:');
      for (const [index, frontendError] of frontendErrors.entries()) {
        console.error(`[E2E] frontend.error #${index + 1}: ${frontendError}`);
      }
    }
  }

  protected async initialize(): Promise<void> {
    const options = this.options;
    const {
      appEnv = {},
      appLogsMode: requestedAppLogsMode,
      focusAppWindow = false,
      sessionMode: requestedSessionMode,
      sessionName: requestedSessionName,
      useDevUpstream = false,
      useTestNetwork: requestedTestNetwork,
    } = options;
    const repoRoot = options.repoRoot ?? Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), '..');
    const sessionMode = requestedSessionMode ?? AppSession.resolveMode(process.env.E2E_SESSION_MODE);
    const useTestNetwork = requestedTestNetwork ?? process.env.E2E_USE_TEST_NETWORK === '1';
    const appLogsMode = requestedAppLogsMode ?? AppSession.resolveLogsMode(process.env.E2E_FLOW_APP_LOGS);
    const autoEnableOperations = options.autoEnableOperations ?? !useDevUpstream;
    const configuredNetworkName = appEnv.ARGON_NETWORK_NAME?.trim();
    const externalNetworkConfigOverride = !useTestNetwork ? appEnv.ARGON_NETWORK_CONFIG_OVERRIDE?.trim() : undefined;
    let externalArchiveUrl: string | undefined;
    if (externalNetworkConfigOverride) {
      if (!configuredNetworkName) {
        throw new Error('[E2E] An external network override requires ARGON_NETWORK_NAME.');
      }
      try {
        const config = JSON.parse(externalNetworkConfigOverride) as { archiveUrl?: unknown };
        if (typeof config.archiveUrl !== 'string' || !/^wss?:\/\//.test(config.archiveUrl)) {
          throw new Error('archiveUrl must use WebSocket transport');
        }
        externalArchiveUrl = config.archiveUrl;
      } catch (error) {
        throw new Error(`[E2E] Invalid external network override: ${(error as Error).message}`);
      }
    }
    if (sessionMode === 'stateful' && useTestNetwork) {
      throw new Error('[E2E] sessionMode=stateful requires useTestNetwork=false (test-network mode always resets).');
    }
    const shouldRunCleanup = sessionMode === 'isolated' && !externalNetworkConfigOverride;

    const driverServer: DriverServer = await startDriverServer();
    const driver = new DriverClient(driverServer.url);
    console.info(`[E2E] Driver session ${driverServer.session}`);
    let appProcess: AppProcess | undefined;
    let testNetwork: StartedArgonTestNetwork | null = null;
    let devUpstreamDir: string | undefined;
    const previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    const previousNetworkConfigOverride = process.env.ARGON_NETWORK_CONFIG_OVERRIDE;
    const previousDevEthereumRuntimeStateDir = process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;
    const previousDevUpstreamDir = process.env.ARGON_DEV_UPSTREAM_DIR;
    const sessionData: Record<string, unknown> = {};

    const defaultSessionName = requestedSessionName || 'e2e';
    const sessionIdentity = resolveTestSessionIdentity({
      sessionName: requestedSessionName,
      fallbackSessionName: defaultSessionName,
      networkName: configuredNetworkName,
    });
    const appInstanceName = sessionIdentity.appInstanceName || sessionIdentity.sessionName;
    const appPort = await chooseAvailablePort(sessionIdentity.appInstancePort);
    const appConfigId = LOCAL_APP_CONFIG_ID;
    const appInstanceDirectory = AppSessionDiagnostics.getInstanceDirectory(
      appConfigId,
      sessionIdentity.composeNetwork,
      appInstanceName,
    );
    const diagnostics = new AppSessionDiagnostics({
      appConfigId,
      networkName: sessionIdentity.composeNetwork,
      instanceName: appInstanceName,
    });
    const { composeProjectName, appEnv: commandEnv } = resolveTestSessionCommandEnv({
      baseEnv: process.env,
      sessionName: requestedSessionName,
      fallbackSessionName: defaultSessionName,
      appPort,
      networkName: configuredNetworkName,
    });
    const isolatedDataEnv: NodeJS.ProcessEnv = {};
    let priceIndexFilePath: string | undefined;
    if (sessionMode === 'isolated') {
      const testDataDir = resolveTestSessionDataDir({
        rootDir: process.env.CI_TEMP_DIR?.trim() || os.tmpdir(),
        sessionId: driverServer.session,
      });
      const devEthereumRuntimeStateDir = Path.join(testDataDir, 'dev-ethereum');
      isolatedDataEnv.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR = devEthereumRuntimeStateDir;
      isolatedDataEnv.ARGON_DEV_UPSTREAM_DIR = resolveDevUpstreamDir({
        ARGON_APP_INSTANCE_DIR: appInstanceDirectory,
      });
      sessionData.devEthereumRuntimeStateDir = devEthereumRuntimeStateDir;
      if (useTestNetwork) {
        priceIndexFilePath = Path.join(testDataDir, 'price-index.json');
        mkdirSync(testDataDir, { recursive: true });
        copyFileSync(Path.join(repoRoot, 'e2e/argon/oracle/test-price-index.json'), priceIndexFilePath);
        sessionData.priceIndexFilePath = priceIndexFilePath;
      }
    }
    const cleanupEnv: NodeJS.ProcessEnv = { ...commandEnv, ...isolatedDataEnv };
    const tauriEnv: NodeJS.ProcessEnv = {
      ...commandEnv,
      ARGON_DRIVER_WS: driverServer.url,
      ARGON_E2E_HEADLESS: process.env.ARGON_E2E_HEADLESS?.trim() || '0',
      ARGON_E2E_FOCUS_APP_WINDOW: focusAppWindow ? '1' : '0',
      ARGON_E2E_AUTO_ENABLE_OPERATIONS: autoEnableOperations ? '1' : '0',
      E2E_USE_TEST_NETWORK: useTestNetwork ? '1' : '0',
      ARGON_APP_ENABLE_AUTOUPDATE: '0',
      ARGON_APP_INSTANCE_DIR: appInstanceDirectory,
      ARGON_DEV_ETHEREUM: '0',
      ...appEnv,
      ...isolatedDataEnv,
    };

    // Keep helper commands (btc-cli, funding RPC) pointed at the same compose project as this session.
    process.env.COMPOSE_PROJECT_NAME = composeProjectName;
    Object.assign(process.env, isolatedDataEnv);

    try {
      if (useTestNetwork) {
        if (shouldRunCleanup) {
          // Reset prior local VM/docker state for this session before bringing up the test network.
          AppSession.cleanDevDocker(repoRoot, cleanupEnv, 'startup');
          await AppSession.waitForPortsReleased(REQUIRED_LOCAL_DOCKER_PORTS, 'startup');
        }

        const previousPriceIndexFilePath = process.env.PRICE_INDEX_FILE_PATH;
        if (priceIndexFilePath) process.env.PRICE_INDEX_FILE_PATH = priceIndexFilePath;
        try {
          testNetwork = await startArgonTestNetwork(sessionIdentity.sessionName, {
            profiles: ['price-oracle'],
            registerTeardown: false,
            composeProjectName,
          });
        } finally {
          AppSession.restoreProcessEnv('PRICE_INDEX_FILE_PATH', previousPriceIndexFilePath);
        }
        sessionData.sessionArchiveUrl = testNetwork.networkConfigOverride.archiveUrl;
        tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(testNetwork.networkConfigOverride);
        process.env.ARGON_NETWORK_CONFIG_OVERRIDE = tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
        const composeEnv = testNetwork.composeEnv;
        tauriEnv.JOIN_COMPOSE_NETWORK = composeEnv.COMPOSE_PROJECT_NAME;
        tauriEnv.RPC_PORT = composeEnv.RPC_PORT;

        if (useDevUpstream) {
          devUpstreamDir = isolatedDataEnv.ARGON_DEV_UPSTREAM_DIR;
          if (!devUpstreamDir) throw new Error('[E2E] Dev upstream requires an isolated data directory.');
          await restartDevUpstreamWorker({
            archiveUrl: testNetwork.archiveUrl,
            devUpstreamDir,
            env: tauriEnv,
            networkConfigOverride: testNetwork.networkConfigOverride,
          });
          sessionData.devUpstreamInviteCode = await AppSession.createDevUpstreamInvite(repoRoot, tauriEnv);
        }

        appProcess = AppProcess.start({
          repoRoot,
          env: tauriEnv,
          command: ['yarn', 'tauri:dev:docker'],
          logsMode: appLogsMode,
          sessionName: sessionIdentity.sessionName,
        });
      } else if (externalNetworkConfigOverride && externalArchiveUrl) {
        sessionData.sessionArchiveUrl = externalArchiveUrl;
        let command = ['yarn', 'tauri:dev'];
        if (options.tauriDevConfig) {
          const configPath = Path.join(repoRoot, 'src-tauri', `tauri.desktop.local.${configuredNetworkName}.conf.json`);
          const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
            app?: { security?: Record<string, unknown> };
            build?: Record<string, unknown>;
          };
          config.build = { ...config.build, devUrl: `http://localhost:${appPort}` };
          if (options.tauriDevConfig.beforeDevCommand) {
            config.build.beforeDevCommand = options.tauriDevConfig.beforeDevCommand;
          }
          config.app = {
            ...config.app,
            security: { ...config.app?.security, capabilities: options.tauriDevConfig.capabilities },
          };
          command = [
            'yarn',
            'tauri',
            'dev',
            '--config',
            JSON.stringify(config),
            '--no-watch',
            '--features',
            'e2e-screenshots,e2e-insecure-gateway-certs',
          ];
        }
        appProcess = AppProcess.start({
          repoRoot,
          env: tauriEnv,
          command,
          logsMode: appLogsMode,
          sessionName: sessionIdentity.sessionName,
        });
      } else {
        delete tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
        sessionData.sessionArchiveUrl = 'ws://127.0.0.1:9944';

        const appCommand = sessionMode === 'stateful' ? 'tauri:dev:docker' : 'dev:docker';
        appProcess = AppProcess.start({
          repoRoot,
          env: tauriEnv,
          command: ['yarn', appCommand],
          logsMode: appLogsMode,
          sessionName: sessionIdentity.sessionName,
        });
      }
    } catch (error) {
      driver.close();
      await driverServer.close();
      if (devUpstreamDir) {
        await stopDevUpstreamWorker(devUpstreamDir).catch(() => undefined);
      }
      if (testNetwork) {
        await testNetwork.stop();
      }
      if (shouldRunCleanup) {
        AppSession.cleanDevDocker(repoRoot, cleanupEnv, 'startup-error');
      }
      AppSession.restoreProcessEnv('COMPOSE_PROJECT_NAME', previousComposeProjectName);
      AppSession.restoreProcessEnv('ARGON_NETWORK_CONFIG_OVERRIDE', previousNetworkConfigOverride);
      AppSession.restoreProcessEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', previousDevEthereumRuntimeStateDir);
      AppSession.restoreProcessEnv('ARGON_DEV_UPSTREAM_DIR', previousDevUpstreamDir);
      appProcess?.output.close();
      throw error;
    }

    const unexpectedExitListener = (code: number | null): void => {
      if (code !== 0) {
        console.error(`[E2E] dev:docker exited with code ${code}`);
        appProcess.output.printTail('process-exit');
      }
    };
    appProcess.child.once('exit', unexpectedExitListener);

    try {
      await driver.connect();
      await appProcess.waitForDriver(driver, DEFAULT_APP_CONNECT_TIMEOUT_MS, async () => {
        appProcess.output.printTail('startup-stall', 40);
        await diagnostics.printStartup({
          repoRoot,
          sessionMode,
          useTestNetwork,
          networkName: sessionIdentity.composeNetwork,
          sessionName: sessionIdentity.sessionName,
          composeProjectName,
          appPort,
          driverUrl: driver.getUrl(),
          appProcess: appProcess.child,
          testNetwork,
        });
      });
      await appProcess.waitForUiReady(driver, APP_STARTUP_READY_TIMEOUT_MS);
    } catch (error) {
      appProcess.output.printTail('connect-error');
      await diagnostics.printFailure('session-startup', error);
      await diagnostics.printStartup({
        repoRoot,
        sessionMode,
        useTestNetwork,
        networkName: sessionIdentity.composeNetwork,
        sessionName: sessionIdentity.sessionName,
        composeProjectName,
        appPort,
        driverUrl: driver.getUrl(),
        appProcess: appProcess.child,
        testNetwork,
      });
      const startupFrontendErrors = driver.getFrontendErrors();
      if (startupFrontendErrors.length > 0) {
        console.error('[E2E] Frontend errors captured during startup:');
        for (const [index, frontendError] of startupFrontendErrors.entries()) {
          console.error(`[E2E] frontend.startup.error #${index + 1}: ${frontendError}`);
        }
      }
      appProcess.child.removeListener('exit', unexpectedExitListener);
      driver.close();
      await appProcess.stop();
      if (devUpstreamDir) {
        await stopDevUpstreamWorker(devUpstreamDir).catch(() => undefined);
      }
      if (testNetwork) {
        await testNetwork.stop();
      }
      if (shouldRunCleanup) {
        AppSession.cleanDevDocker(repoRoot, cleanupEnv, 'connect-error');
      }
      await driverServer.close();
      AppSession.restoreProcessEnv('COMPOSE_PROJECT_NAME', previousComposeProjectName);
      AppSession.restoreProcessEnv('ARGON_NETWORK_CONFIG_OVERRIDE', previousNetworkConfigOverride);
      AppSession.restoreProcessEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', previousDevEthereumRuntimeStateDir);
      AppSession.restoreProcessEnv('ARGON_DEV_UPSTREAM_DIR', previousDevUpstreamDir);
      appProcess.output.close();
      throw error;
    }

    this.instanceDirectory = appInstanceDirectory;
    this.appProcess = appProcess;
    this.cleanupEnv = cleanupEnv;
    this.diagnostics = diagnostics;
    this.devUpstreamDir = devUpstreamDir;
    this.driver = driver;
    this.driverServer = driverServer;
    this.previousComposeProjectName = previousComposeProjectName;
    this.previousDevEthereumRuntimeStateDir = previousDevEthereumRuntimeStateDir;
    this.previousDevUpstreamDir = previousDevUpstreamDir;
    this.previousNetworkConfigOverride = previousNetworkConfigOverride;
    this.repoRoot = repoRoot;
    this.sessionData = sessionData;
    this.shouldRunCleanup = shouldRunCleanup;
    this.testNetwork = testNetwork;
    this.unexpectedExitListener = unexpectedExitListener;
  }

  private static async createDevUpstreamInvite(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync('tsx', ['e2e/scripts/devUpstreamInvite.ts'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const inviteCode = stdout.match(/\[dev-upstream-invite\] Invite code: (.+)/)?.[1]?.trim();
    if (!inviteCode) throw new Error(`[E2E] Dev upstream did not return an invite code.\n${stdout}`);
    return inviteCode;
  }

  private static restoreProcessEnv(name: string, previousValue: string | undefined): void {
    if (previousValue === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = previousValue;
  }

  private static cleanDevDocker(repoRoot: string, env: NodeJS.ProcessEnv, reason: string): void {
    try {
      execFileSync('yarn', ['clean:dev:docker:instance'], {
        cwd: repoRoot,
        env,
        shell: true,
        stdio: 'inherit',
      });
    } catch (error) {
      console.warn(`[E2E] clean:dev:docker failed (${reason}): ${(error as Error).message}`);
    }
  }

  private static async waitForPortsReleased(
    ports: number[],
    reason: string,
    timeoutMs: number = CLEANUP_PORT_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      const checks = await Promise.all(ports.map(async port => ({ port, free: await isPortAvailable(port) })));
      const blocked = checks.filter(item => !item.free).map(item => item.port);
      if (blocked.length === 0) return;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Required local port(s) still in use after cleanup (${reason}): ${blocked.join(', ')} (waited ${timeoutMs}ms)`,
        );
      }
      await delay(CLEANUP_PORT_POLL_INTERVAL_MS);
    }
  }
}
