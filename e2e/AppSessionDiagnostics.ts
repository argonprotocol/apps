import { type ChildProcess, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import Path from 'node:path';
import process from 'node:process';
import { isPortAvailable } from '../scripts/utils.ts';
import type { StartedArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';

const FAILED_STEP_LOG_TAIL_LINES = 180;
const TROUBLESHOOTING_BUNDLE_TIMEOUT_MS = 30_000;
const REQUIRED_LOCAL_DOCKER_PORTS = [3261];
const DOCKER_COMPOSE_CONFIG_FILES = ['docker-compose.yml', 'indexer.docker-compose.yml'] as const;

export class AppSessionDiagnostics {
  private readonly appConfigId: string;
  private readonly networkName: string;
  private readonly instanceName: string;

  constructor(args: { appConfigId: string; networkName: string; instanceName: string }) {
    const { appConfigId, networkName, instanceName } = args;
    this.appConfigId = appConfigId;
    this.networkName = networkName;
    this.instanceName = instanceName;
  }

  public static getInstanceDirectory(appConfigId: string, networkName: string, instanceName: string): string {
    return Path.join(this.getConfigBaseDirectory(), appConfigId, networkName, instanceName);
  }

  public async printFailure(label: string, error: unknown): Promise<void> {
    const instanceDirectory = AppSessionDiagnostics.getInstanceDirectory(
      this.appConfigId,
      this.networkName,
      this.instanceName,
    );
    const appDirectory = Path.join(instanceDirectory, 'virtual-machine', 'app');
    const logDirectory = Path.join(appDirectory, 'logs');

    console.error('[E2E] ==========================================');
    console.error('[E2E] Flow failed; fetching server install logs before teardown');
    console.error(`[E2E] Flow: ${label}`);
    console.error(`[E2E] Error: ${error instanceof Error ? error.message : String(error)}`);

    const workerLogPath = Path.join(instanceDirectory, 'dev-upstream', 'operator-worker.log');
    if (existsSync(workerLogPath)) {
      console.error(`[E2E] Recent upstream worker output from ${workerLogPath}:`);
      this.printFileTail(workerLogPath, FAILED_STEP_LOG_TAIL_LINES);
      const ciTempDir = process.env.CI_TEMP_DIR?.trim();
      if (ciTempDir) {
        const artifactPath = Path.join(ciTempDir, `e2e-upstream-worker-${this.instanceName}.log`);
        try {
          copyFileSync(workerLogPath, artifactPath);
          console.error(`[E2E] Full upstream worker log: ${artifactPath}`);
        } catch (copyError) {
          console.warn(`[E2E] Could not preserve upstream worker log: ${(copyError as Error).message}`);
        }
      }
    }

    if (!existsSync(logDirectory)) {
      console.warn('[E2E] No local server log directory found for this session.');
      await this.createTroubleshootingBundle(appDirectory);
      return;
    }

    console.error(`[E2E] Reading server logs from ${logDirectory}`);
    let entries: string[];
    try {
      entries = readdirSync(logDirectory);
    } catch (readError) {
      console.warn(`[E2E] Unable to read ${logDirectory}: ${(readError as Error).message}`);
      await this.createTroubleshootingBundle(appDirectory);
      return;
    }

    const failedFiles = entries.filter(name => /\.Failed$/.test(name)).sort((a, b) => a.localeCompare(b));
    if (failedFiles.length === 0) {
      console.warn(`[E2E] No .Failed install step files found under ${logDirectory}`);
      const finishedFiles = entries.filter(name => /\.Finished$/i.test(name)).sort((a, b) => a.localeCompare(b));
      const logFiles = entries.filter(name => /\.log$/i.test(name)).sort((a, b) => a.localeCompare(b));
      const fallbackTargets = [...new Set([...finishedFiles.slice(-2), ...logFiles.slice(-2)])];
      if (fallbackTargets.length === 0) {
        console.warn(`[E2E] No install log artifacts found under ${logDirectory}`);
      }
      for (const fallbackFile of fallbackTargets) {
        const fallbackPath = Path.join(logDirectory, fallbackFile);
        console.error(`[E2E] --- Recent artifact: ${fallbackFile} ---`);
        try {
          console.error(this.tailText(readFileSync(fallbackPath, 'utf8'), FAILED_STEP_LOG_TAIL_LINES));
        } catch (logError) {
          console.warn(`[E2E] Could not read ${fallbackPath}: ${(logError as Error).message}`);
        }
      }
    } else {
      for (const failedFile of failedFiles) {
        const stepFilePath = Path.join(logDirectory, failedFile);
        const baseName = failedFile.replace(/^step-/, '').replace(/\.Failed$/, '');
        const logFilePath = Path.join(logDirectory, `step-${baseName}.log`);
        const finishedFilePath = Path.join(logDirectory, `step-${baseName}.Finished`);

        console.error(`[E2E] --- Failed step: ${baseName} ---`);
        this.printFileTail(stepFilePath, FAILED_STEP_LOG_TAIL_LINES);
        if (existsSync(logFilePath)) {
          console.error(`[E2E] tail(${FAILED_STEP_LOG_TAIL_LINES}) step-${baseName}.log`);
          this.printFileTail(logFilePath, FAILED_STEP_LOG_TAIL_LINES);
        }
        if (existsSync(finishedFilePath)) {
          console.error(`[E2E] step-${baseName}.Finished`);
          this.printFileTail(finishedFilePath, FAILED_STEP_LOG_TAIL_LINES);
        }
      }
    }

    await this.createTroubleshootingBundle(appDirectory);
    console.error('[E2E] ==========================================');
  }

  public async printStartup(args: {
    repoRoot: string;
    sessionMode: 'isolated' | 'stateful';
    useTestNetwork: boolean;
    networkName: string;
    sessionName: string;
    composeProjectName: string;
    appPort: number;
    driverUrl: string;
    appProcess: ChildProcess;
    testNetwork: StartedArgonTestNetwork | null;
  }): Promise<void> {
    const trackedPorts = [...new Set([...REQUIRED_LOCAL_DOCKER_PORTS, args.appPort])];
    const portDiagnostics = await Promise.all(
      trackedPorts.map(async port => ({ port, available: await isPortAvailable(port) })),
    );
    const blockedRequiredPorts = portDiagnostics.filter(
      item => REQUIRED_LOCAL_DOCKER_PORTS.includes(item.port) && !item.available,
    );
    const composePsOutput = this.readComposeStatus(
      args.repoRoot,
      args.testNetwork?.composeEnv ?? { ...process.env, COMPOSE_PROJECT_NAME: args.composeProjectName },
    );

    console.error('[E2E] ==========================================');
    console.error('[E2E] Session startup diagnostics');
    console.error(
      `[E2E] Session: mode=${args.sessionMode} useTestNetwork=${args.useTestNetwork} network=${args.networkName} session=${args.sessionName} composeProject=${args.composeProjectName} appInstance=${this.instanceName} appPort=${args.appPort}`,
    );
    console.error(`[E2E] Driver: ${args.driverUrl}`);
    console.error(
      `[E2E] App process: pid=${String(args.appProcess.pid ?? 'n/a')} exitCode=${String(args.appProcess.exitCode ?? null)} signal=${String(args.appProcess.signalCode ?? null)}`,
    );
    console.error(
      `[E2E] Required fixed ports still in use: ${blockedRequiredPorts.length ? blockedRequiredPorts.map(item => item.port).join(', ') : 'none'}`,
    );
    for (const portDiagnostic of portDiagnostics) {
      console.error(`[E2E] Port ${portDiagnostic.port}: ${portDiagnostic.available ? 'available' : 'in use'}`);
    }
    if (args.testNetwork) {
      console.error(
        `[E2E] Test network endpoints: archive-node=${args.testNetwork.archiveUrl} app-rpc=${args.testNetwork.networkConfigOverride.archiveUrl} notary=${args.testNetwork.notaryUrl} esplora=${args.testNetwork.networkConfigOverride.esploraHost} indexer=${args.testNetwork.networkConfigOverride.indexerHost ?? 'n/a'}`,
      );
    } else {
      console.error('[E2E] No test network handle available for this startup failure.');
    }
    console.error('[E2E] docker compose ps --all');
    console.error(composePsOutput);
    console.error('[E2E] ==========================================');
  }

  private static getConfigBaseDirectory(): string {
    if (process.platform === 'darwin') {
      return Path.join(process.env.HOME ?? '', 'Library', 'Application Support');
    }
    if (process.platform === 'win32') {
      return process.env.APPDATA || Path.join(process.env.HOME ?? '', 'AppData', 'Roaming');
    }
    return process.env.XDG_CONFIG_HOME || Path.join(process.env.HOME ?? '', '.config');
  }

  private printFileTail(path: string, lineLimit: number): void {
    try {
      console.error(this.tailText(readFileSync(path, 'utf8'), lineLimit));
    } catch (error) {
      console.warn(`[E2E] Could not read ${path}: ${(error as Error).message}`);
    }
  }

  private tailText(text: string, lineLimit: number): string {
    if (!text) return '';
    const lines = text.replace(/\r\n?/g, '\n').trimEnd().split('\n');
    return lines.slice(Math.max(0, lines.length - lineLimit)).join('\n');
  }

  private async createTroubleshootingBundle(appDirectory: string): Promise<void> {
    if (process.platform === 'win32') {
      console.warn('[E2E] Skipping troubleshooting bundle generation on Windows.');
      return;
    }
    if (!existsSync(appDirectory)) {
      console.warn('[E2E] No local app directory found for troubleshooting bundle generation.');
      return;
    }
    const scriptPath = Path.join(appDirectory, 'server', 'scripts', 'create_troubleshooting_gz.sh');
    if (!existsSync(scriptPath)) {
      console.warn(`[E2E] Troubleshooting script not found at ${scriptPath}`);
      return;
    }

    console.error(`[E2E] Creating troubleshooting bundle from ${appDirectory}`);
    try {
      const output = execFileSync('/bin/bash', [scriptPath], {
        cwd: appDirectory,
        encoding: 'utf8',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        timeout: TROUBLESHOOTING_BUNDLE_TIMEOUT_MS,
      });
      const archivePath = output.match(/Bundle ready: (.+\.tar\.gz)/)?.[1]?.trim();
      if (archivePath) {
        console.error(`[E2E] Troubleshooting bundle ready: ${archivePath}`);
      } else if (output.trim()) {
        console.error('[E2E] Troubleshooting bundle output:');
        console.error(this.tailText(output, 40));
      }
    } catch (error) {
      console.warn(
        `[E2E] Failed to create troubleshooting bundle from ${appDirectory}: ${this.formatBundleError(error)}`,
      );
    }
  }

  private formatBundleError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const streams = error as Error & { stdout?: unknown; stderr?: unknown };
    const stdout = typeof streams.stdout === 'string' ? streams.stdout : '';
    const stderr = typeof streams.stderr === 'string' ? streams.stderr : '';
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
    return details ? `${error.message}\n${this.tailText(details, 40)}` : error.message;
  }

  private readComposeStatus(repoRoot: string, env: NodeJS.ProcessEnv): string {
    const composeDirectory = Path.resolve(repoRoot, 'e2e', 'argon');
    const args = DOCKER_COMPOSE_CONFIG_FILES.flatMap(file => ['-f', file]).concat(['ps', '--all']);
    try {
      const output = execFileSync('docker', ['compose', ...args], {
        cwd: composeDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      return output.trim() || '[E2E] docker compose ps returned no output';
    } catch (error) {
      const composeError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
      const stdout =
        typeof composeError.stdout === 'string' ? composeError.stdout : (composeError.stdout?.toString('utf8') ?? '');
      const stderr =
        typeof composeError.stderr === 'string' ? composeError.stderr : (composeError.stderr?.toString('utf8') ?? '');
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return details
        ? `[E2E] docker compose ps failed\n${details}`
        : `[E2E] docker compose ps failed: ${composeError.message}`;
    }
  }
}
