import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { ensureDevGatewayCerts } from '../devGatewayCerts.ts';
import {
  getDevUpstreamWorkerPaths,
  restartDevUpstreamWorker,
  stopDevUpstreamWorker,
  watchAppInstanceDirectory,
} from '../../e2e/scripts/devUpstreamProcess.ts';

describe('dev upstream worker lifecycle', () => {
  let env: NodeJS.ProcessEnv | undefined;
  let devUpstreamDir: string | undefined;
  let unrelatedWorkerPid: number | undefined;

  // Cleanup includes native process ownership checks and the worker's shutdown grace period.
  afterEach(async () => {
    if (devUpstreamDir) await stopDevUpstreamWorker(devUpstreamDir);
    if (unrelatedWorkerPid && isProcessRunning(unrelatedWorkerPid)) {
      try {
        process.kill(process.platform === 'win32' ? unrelatedWorkerPid : -unrelatedWorkerPid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (devUpstreamDir) Fs.rmSync(devUpstreamDir, { recursive: true, force: true });
  }, 30_000);

  // Certificate generation and a cold worker launch need the same budget as the replacement test below.
  it('lets the detached Node worker read the mailbox capability over local gateway TLS', async () => {
    devUpstreamDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-tls-'));
    const certHome = Path.join(devUpstreamDir, 'ca');
    env = {
      ...process.env,
      ARGON_DEV_GATEWAY_CERT_HOME: certHome,
      ARGON_DEV_GATEWAY_CERT_TARGETS: Path.join(devUpstreamDir, 'gateway-certs'),
      ARGON_DEV_GATEWAY_SKIP_TRUST: '1',
    };
    await ensureDevGatewayCerts({ env });

    const gateway = createServer(
      {
        key: Fs.readFileSync(Path.join(certHome, 'localhost', 'privkey.pem')),
        cert: Fs.readFileSync(Path.join(certHome, 'localhost', 'fullchain.pem')),
      },
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ bitcoinCooperativeReleaseMailboxVersion: 1 }));
      },
    );
    onTestFinished(() => new Promise<void>(resolve => gateway.close(() => resolve())));
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `https://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    const resultPath = Path.join(devUpstreamDir, 'gateway-response.json');
    const workerPath = Path.join(devUpstreamDir, 'gateway-worker.cjs');
    Fs.writeFileSync(
      workerPath,
      `
      const Fs = require('node:fs');
      fetch(${JSON.stringify(gatewayUrl)}).then(async response => {
        Fs.writeFileSync(${JSON.stringify(resultPath)}, await response.text());
        const state = JSON.parse(Fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
        Fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ ...state, ready: true }));
        setInterval(() => undefined, 1_000);
      }).catch(error => { console.error(error); process.exit(1); });
    `,
    );
    await restartDevUpstreamWorker({
      archiveUrl: 'ws://127.0.0.1:9944',
      env: { ...env, NODE_EXTRA_CA_CERTS: '' },
      devUpstreamDir,
      workerPath,
    });
    expect(JSON.parse(Fs.readFileSync(resultPath, 'utf8'))).toEqual({ bitcoinCooperativeReleaseMailboxVersion: 1 });
  }, 60_000);

  it('releases the process owner when its app instance directory is removed', async () => {
    const instanceDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-app-instance-'));

    let releaseLease: VoidFunction = () => undefined;
    const released = new Promise<void>(resolve => {
      releaseLease = resolve;
    });
    const watcher = watchAppInstanceDirectory(instanceDir, releaseLease);

    Fs.rmSync(instanceDir, { recursive: true });

    await expect(Promise.race([released.then(() => true), delay(2_000).then(() => false)])).resolves.toBe(true);
    watcher.close();
  });

  it('releases the process owner when its app instance directory was already removed', async () => {
    const instanceDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-app-instance-'));
    Fs.rmSync(instanceDir, { recursive: true });

    let releaseLease: VoidFunction = () => undefined;
    const released = new Promise<void>(resolve => {
      releaseLease = resolve;
    });
    const watcher = watchAppInstanceDirectory(instanceDir, releaseLease);

    await expect(Promise.race([released.then(() => true), delay(2_000).then(() => false)])).resolves.toBe(true);
    watcher.close();
  });

  it('replaces the detached worker on each dev launch and stops it for visible-app handoff', async () => {
    devUpstreamDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-worker-'));
    env = {
      ...process.env,
      ARGON_APP_INSTANCE: 'worker-test',
      ARGON_NETWORK_NAME: 'dev-docker',
    };
    const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    expect(statePath).toBe(Path.join(devUpstreamDir, 'operator-worker.json'));
    Fs.mkdirSync(Path.dirname(statePath), { recursive: true });
    const workerPath = createWorkerFixture(devUpstreamDir, statePath);

    const options = {
      archiveUrl: 'ws://127.0.0.1:9944',
      env,
      devUpstreamDir,
      workerPath,
    };
    const firstPid = await restartDevUpstreamWorker(options);
    const { logPath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    Fs.appendFileSync(logPath, 'stale failure from the previous launch\n');
    const replacementPid = await restartDevUpstreamWorker(options);

    expect(replacementPid).not.toBe(firstPid);
    expect(isProcessRunning(firstPid)).toBe(false);
    expect(Fs.readFileSync(logPath, 'utf8')).toMatch(/^\[dev-upstream-worker\] Starting new launch at /);
    expect(Fs.readFileSync(logPath, 'utf8')).not.toContain('stale failure from the previous launch');

    await stopDevUpstreamWorker(devUpstreamDir, 'SIGUSR2');

    expect(Fs.existsSync(statePath)).toBe(false);
  }, 60_000);

  it('removes failed startup state so the next launch can succeed', async () => {
    devUpstreamDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-worker-'));
    env = {
      ...process.env,
      ARGON_APP_INSTANCE: 'worker-test',
      ARGON_NETWORK_NAME: 'dev-docker',
    };
    const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    Fs.mkdirSync(Path.dirname(statePath), { recursive: true });
    const failedWorkerPath = createWorkerFixture(devUpstreamDir, statePath, false);
    const options = {
      archiveUrl: 'ws://127.0.0.1:9944',
      env,
      devUpstreamDir,
      workerPath: failedWorkerPath,
    };

    await expect(restartDevUpstreamWorker(options)).rejects.toThrow('exited during startup');
    expect(Fs.existsSync(statePath)).toBe(false);

    options.workerPath = createWorkerFixture(devUpstreamDir, statePath);
    await expect(restartDevUpstreamWorker(options)).resolves.toBeTypeOf('number');
  });

  it.skipIf(process.platform === 'win32')('fails startup when the worker leader exits before its child', async () => {
    devUpstreamDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-worker-'));
    env = {
      ...process.env,
      ARGON_APP_INSTANCE: 'worker-test',
      ARGON_NETWORK_NAME: 'dev-docker',
    };
    const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    Fs.mkdirSync(Path.dirname(statePath), { recursive: true });
    const workerPath = createWorkerFixture(devUpstreamDir, statePath, false, 5_000);
    const startedAt = Date.now();

    await expect(
      restartDevUpstreamWorker({
        archiveUrl: 'ws://127.0.0.1:9944',
        env,
        devUpstreamDir,
        workerPath,
      }),
    ).rejects.toThrow('exited during startup');

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('does not signal an unrelated process that reused a stale worker pid', async () => {
    devUpstreamDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-upstream-worker-'));
    env = {
      ...process.env,
      ARGON_APP_INSTANCE: 'worker-test',
      ARGON_NETWORK_NAME: 'dev-docker',
    };
    const { statePath } = getDevUpstreamWorkerPaths(devUpstreamDir);
    Fs.mkdirSync(Path.dirname(statePath), { recursive: true });
    const workerPath = createWorkerFixture(devUpstreamDir, statePath);
    const unrelatedWorker = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (!unrelatedWorker.pid) throw new Error('Unable to start unrelated worker fixture');
    unrelatedWorkerPid = unrelatedWorker.pid;
    unrelatedWorker.unref();
    Fs.writeFileSync(statePath, JSON.stringify({ pid: unrelatedWorker.pid, ready: true, launchId: 'stale-launch' }));

    await expect(
      restartDevUpstreamWorker({
        archiveUrl: 'ws://127.0.0.1:9944',
        env,
        devUpstreamDir,
        workerPath,
      }),
    ).resolves.toBeTypeOf('number');

    expect(isProcessRunning(unrelatedWorker.pid)).toBe(true);
  });
});

function createWorkerFixture(
  devUpstreamDir: string,
  statePath: string,
  becomeReady = true,
  childLifetimeMs = 0,
): string {
  const fixturePath = Path.join(devUpstreamDir, 'worker-fixture.cjs');
  Fs.writeFileSync(
    fixturePath,
    `
      const Fs = require('node:fs');
      const statePath = ${JSON.stringify(statePath)};
      if (${JSON.stringify(childLifetimeMs)} > 0) {
        require('node:child_process').spawn(
          process.execPath,
          ['-e', ${JSON.stringify(`setTimeout(() => undefined, ${childLifetimeMs})`)}],
          { stdio: 'ignore' },
        ).unref();
      }
      if (!${JSON.stringify(becomeReady)}) process.exit(1);
      const publishReady = () => {
        if (!Fs.existsSync(statePath)) return setTimeout(publishReady, 10);
        const state = JSON.parse(Fs.readFileSync(statePath, 'utf8'));
        Fs.writeFileSync(statePath, JSON.stringify({ ...state, ready: true }));
      };
      publishReady();
      setInterval(() => undefined, 1_000);
    `,
  );
  return fixturePath;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
