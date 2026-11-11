import { execFileSync } from 'node:child_process';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureDevEnvironment } from '../../dev/environment.ts';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

describe('dev Docker environment', () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let directory: string;
  let socketPath: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DOCKER_HOST;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-environment-'));
    process.env.ARGON_APP_INSTANCE_DIR = Path.join(directory, 'socket-test');
    process.env.ARGON_APP_INSTANCE = 'socket-test';
    socketPath = Path.join(directory, 'docker.sock');
    Fs.writeFileSync(socketPath, '');
    const defaultSocketPath = Path.join(directory, 'default-docker.sock');
    Fs.symlinkSync(socketPath, defaultSocketPath);

    const realpathSync = Fs.realpathSync;
    vi.spyOn(Fs, 'realpathSync').mockImplementation(file =>
      realpathSync(file === '/var/run/docker.sock' ? defaultSocketPath : file),
    );
    vi.mocked(execFileSync).mockReset().mockReturnValue(`unix://${socketPath}\n`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Fs.rmSync(directory, { recursive: true, force: true });
  });

  it('uses the equivalent standard macOS socket for Kurtosis and Compose', async () => {
    const { context } = await configureDevEnvironment({ network: 'dev-docker', instance: 'socket-test' });

    expect(process.env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    expect(context.composeEnv.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
  });

  it('keeps a context pointing to a different Docker socket', async () => {
    const otherSocketPath = Path.join(directory, 'other-docker.sock');
    Fs.writeFileSync(otherSocketPath, '');
    vi.mocked(execFileSync).mockReturnValue(`unix://${otherSocketPath}\n`);

    await configureDevEnvironment({ network: 'dev-docker', instance: 'socket-test' });

    expect(process.env.DOCKER_HOST).toBe(`unix://${otherSocketPath}`);
  });

  it('keeps the context socket when the standard socket is unavailable', async () => {
    Fs.unlinkSync(Path.join(directory, 'default-docker.sock'));

    await configureDevEnvironment({ network: 'dev-docker', instance: 'socket-test' });

    expect(process.env.DOCKER_HOST).toBe(`unix://${socketPath}`);
  });

  it('keeps the context socket on Linux even when a standard alias exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await configureDevEnvironment({ network: 'dev-docker', instance: 'socket-test' });

    expect(process.env.DOCKER_HOST).toBe(`unix://${socketPath}`);
  });

  it('preserves an explicit Docker host without querying the context', async () => {
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:2376';
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('The explicit Docker host must take precedence over the context.');
    });

    const { context } = await configureDevEnvironment({ network: 'dev-docker', instance: 'socket-test' });

    expect(process.env.DOCKER_HOST).toBe('tcp://127.0.0.1:2376');
    expect(context.composeEnv.DOCKER_HOST).toBe('tcp://127.0.0.1:2376');
  });
});
