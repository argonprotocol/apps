import { spawn } from 'node:child_process';
import Fs from 'node:fs';
import { format } from 'node:util';

export class DevOutput {
  readonly fd: number;
  private readonly consoleMethods = { ...console };

  constructor(public readonly logPath: string) {
    this.fd = Fs.openSync(logPath, 'a', 0o600);
    Fs.writeSync(this.fd, `\nStarted ${new Date().toISOString()}\n`);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = (...args: unknown[]) => Fs.writeSync(this.fd, `${format(...args)}\n`);
    }
  }

  public progress(message: string): void {
    Fs.writeSync(this.fd, `[dev] ${message}\n`);
    process.stdout.write(`[dev] ${message}\n`);
  }

  public async run(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; stream?: boolean } = {},
  ): Promise<void> {
    const { env = process.env, cwd = process.cwd(), stream = false } = options;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
      });
      child.stdout?.on('data', (data: Buffer) => {
        Fs.writeSync(this.fd, data);
        if (stream) process.stdout.write(data);
      });
      child.stderr?.on('data', (data: Buffer) => {
        Fs.writeSync(this.fd, data);
        if (stream) process.stderr.write(data);
      });
      const stop = () => {
        if (!child.pid || child.exitCode !== null) return;
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code}). Logs: ${this.logPath}`));
      });
    });
  }

  public close(): void {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = this.consoleMethods[method];
    }
    Fs.closeSync(this.fd);
  }
}
