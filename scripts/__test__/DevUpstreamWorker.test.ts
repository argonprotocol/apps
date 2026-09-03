import { spawn, type ChildProcess } from 'node:child_process';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDevUpstreamWorker,
  getDevUpstreamWorkerPaths,
  stopDevUpstreamWorker,
} from '../../e2e/scripts/devUpstreamProcess.ts';

describe('dev upstream worker lifecycle', () => {
  let worker: ChildProcess | undefined;
  let rootDir: string | undefined;

  afterEach(async () => {
    if (worker?.exitCode === null && worker.pid) process.kill(worker.pid, 'SIGKILL');
    if (rootDir) Fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('reuses a running worker until the visible upstream app requests handoff', async () => {
    rootDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-worker-'));
    const { pidPath, readyPath } = getDevUpstreamWorkerPaths(rootDir);
    Fs.mkdirSync(Path.dirname(pidPath), { recursive: true });

    worker = spawn(
      process.execPath,
      [
        '-e',
        `
          const Fs = require('node:fs');
          Fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
          Fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
          process.on('SIGUSR2', () => {
            Fs.rmSync(${JSON.stringify(readyPath)}, { force: true });
            Fs.rmSync(${JSON.stringify(pidPath)}, { force: true });
            process.exit(0);
          });
          setInterval(() => undefined, 1_000);
        `,
      ],
      { stdio: 'ignore' },
    );

    await waitFor(() => Fs.existsSync(readyPath));
    const pid = await ensureDevUpstreamWorker({
      archiveUrl: 'ws://127.0.0.1:9944',
      env: {},
      rootDir,
    });

    expect(pid).toBe(worker.pid);
    expect(worker.exitCode).toBeNull();

    await stopDevUpstreamWorker(rootDir, 'SIGUSR2');

    expect(worker.exitCode).toBe(0);
    expect(Fs.existsSync(pidPath)).toBe(false);
    expect(Fs.existsSync(readyPath)).toBe(false);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > 5_000) throw new Error('Timed out waiting for worker state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
