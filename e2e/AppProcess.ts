import { type ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';
import { delay } from '../scripts/utils.ts';
import { AppProcessOutput, type AppLogsMode } from './AppProcessOutput.ts';
import { DriverClient } from './driver/client.ts';

const CONNECT_PROGRESS_INTERVAL_MS = 20_000;
const CONNECT_STALL_DIAGNOSTIC_MS = 60_000;
const UI_READY_RETRY_DELAY_MS = 1_000;
const UI_READY_WAIT_TIMEOUT_MS = 15_000;

export class AppProcess {
  public readonly output: AppProcessOutput;

  private constructor(
    public readonly child: ChildProcess,
    logsMode: AppLogsMode,
    sessionName: string,
  ) {
    this.output = new AppProcessOutput(logsMode, sessionName);
    this.output.attach(child);
  }

  public static start(args: {
    repoRoot: string;
    env: NodeJS.ProcessEnv;
    command: string[];
    logsMode: AppLogsMode;
    sessionName: string;
  }): AppProcess {
    const { repoRoot, env, command, logsMode, sessionName } = args;
    const [executable, ...commandArgs] = command;
    if (!executable) throw new Error('App process command is empty');
    const child = spawn(executable, commandArgs, {
      cwd: repoRoot,
      env,
      stdio: logsMode === 'quiet' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: process.platform !== 'win32',
    });
    return new AppProcess(child, logsMode, sessionName);
  }

  public async waitForDriver(
    driver: DriverClient,
    timeoutMs: number,
    onStall?: () => Promise<void> | void,
  ): Promise<void> {
    const { child, output } = this;
    console.info(`[E2E] Waiting for app connection (timeout ${timeoutMs}ms)`);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let hasPrintedStallDiagnostics = false;
      const startedAt = Date.now();

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(progressInterval);
        child.off('exit', onExit);
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
      const timeout = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `Timed out waiting for app connection after ${timeoutMs}ms (driver ${driver.getUrl()}, pid=${String(child.pid ?? 'n/a')}, exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
            ),
          ),
        );
      }, timeoutMs);
      const progressInterval = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = Math.max(0, timeoutMs - elapsedMs);
        const startup = output.summarizeStartup();
        const lastOutputAge = startup.lastOutputAgeMs == null ? 'n/a' : `${startup.lastOutputAgeMs}`;
        const lastOutput = startup.lastOutputLine ? ` lastOutput=${startup.lastOutputLine}` : '';

        console.warn(
          `[E2E] Still waiting for app connection (elapsedMs=${elapsedMs}, remainingMs=${remainingMs}, stage=${startup.stage}, lastOutputAgeMs=${lastOutputAge}, pid=${String(child.pid ?? 'n/a')}, exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})${lastOutput}`,
        );
        if (!hasPrintedStallDiagnostics && elapsedMs >= CONNECT_STALL_DIAGNOSTIC_MS) {
          hasPrintedStallDiagnostics = true;
          console.warn(`[E2E] App connection appears stalled at stage=${startup.stage}; printing startup diagnostics`);
          void Promise.resolve(onStall?.()).catch(error => {
            console.warn(
              `[E2E] Failed to print startup stall diagnostics: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }, CONNECT_PROGRESS_INTERVAL_MS);

      child.once('exit', onExit);
      void driver
        .waitForApp()
        .then(() => finish(resolve))
        .catch(error => finish(() => reject(error)));
    });
  }

  public async waitForUiReady(driver: DriverClient, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(
          `[E2E] App process exited before initial UI readiness check (code=${String(this.child.exitCode)}, signal=${String(this.child.signalCode)})`,
        );
      }

      attempt += 1;
      try {
        await driver.command('ui.waitFor', {
          selector: '#app',
          state: 'exists',
          timeoutMs: UI_READY_WAIT_TIMEOUT_MS,
        });
        if (attempt > 1) console.info(`[E2E] App became ready after startup retry (attempt=${attempt})`);
        return;
      } catch (error) {
        if (!DriverClient.isRetryableConnectionError(error)) throw error;
        const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
        console.warn(
          `[E2E] Initial UI readiness command failed during app startup (attempt=${attempt}, remainingMs=${remainingMs}); retrying`,
        );
        await delay(UI_READY_RETRY_DELAY_MS);
      }
    }

    throw new Error(
      `[E2E] Timed out waiting for initial UI readiness after ${timeoutMs}ms (attempts=${attempt}, pid=${String(this.child.pid ?? 'n/a')}, exitCode=${String(this.child.exitCode)}, signal=${String(this.child.signalCode)})`,
    );
  }

  public async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.signal('SIGINT');
    if (await this.waitForExit(20_000)) return;
    this.signal('SIGTERM');
    if (await this.waitForExit(10_000)) return;
    this.signal('SIGKILL');
    await this.waitForExit(5_000);
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.child.pid && process.platform !== 'win32') {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // Fall through to direct signaling when the process group is already gone.
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // The process may exit between the state check and signal.
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      this.child.once('exit', onExit);
    });
  }
}
