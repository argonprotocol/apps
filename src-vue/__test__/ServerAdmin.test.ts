import { expect, it, vi } from 'vitest';
import { InstallStepKey, ServerType } from '../interfaces/IConfig.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';

it('advances server collection progress without completing it before the archive is ready', async () => {
  vi.useFakeTimers();
  let rejectCollection: (error: Error) => void = () => undefined;
  const connection = {
    runCommandWithTimeout: vi.fn().mockReturnValue(
      new Promise((_, reject) => {
        rejectCollection = reject;
      }),
    ),
  };
  const server = new ServerAdmin(connection as any, {
    ipAddress: '127.0.0.1',
    sshUser: 'root',
    type: ServerType.CustomServer,
    workDir: '/root',
  });
  const onProgress = vi.fn();

  try {
    const download = server.downloadTroubleshootingPackage(onProgress);

    expect(onProgress).toHaveBeenLastCalledWith(5);
    await vi.advanceTimersByTimeAsync(60e3);
    const progressAtOneMinute = onProgress.mock.lastCall?.[0] as number;
    expect(progressAtOneMinute).toBeGreaterThan(5);
    expect(progressAtOneMinute).toBeLessThan(24);

    await vi.advanceTimersByTimeAsync(30e3);
    expect(onProgress.mock.lastCall?.[0]).toBeGreaterThan(progressAtOneMinute);
    expect(onProgress.mock.lastCall?.[0]).toBeLessThan(24);

    rejectCollection(new Error('collection stopped'));
    await expect(download).rejects.toThrow('collection stopped');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('reports troubleshooting script output when the remote bundle cannot be created', async () => {
  const connection = {
    runCommandWithTimeout: vi.fn().mockResolvedValue(['Copying data folders\nArchive creation failed', 1]),
  };
  const server = new ServerAdmin(connection as any, {
    ipAddress: '127.0.0.1',
    sshUser: 'root',
    type: ServerType.CustomServer,
    workDir: '/root',
  });

  await expect(server.downloadTroubleshootingPackage(vi.fn())).rejects.toThrow('Archive creation failed');
  expect(connection.runCommandWithTimeout).toHaveBeenCalledWith(
    'sudo /root/server/scripts/create_troubleshooting_gz.sh',
    180e3,
    0,
  );
});

it('reads installer failure details from the case-sensitive failure marker', async () => {
  const connection = {
    runCommandWithTimeout: vi
      .fn()
      .mockResolvedValue(['[2026-07-10 15:42:56] Server gateway did not become ready after 120 seconds', 0]),
  };
  const server = new ServerAdmin(connection as any, {
    ipAddress: '127.0.0.1',
    sshUser: 'root',
    type: ServerType.CustomServer,
    workDir: '/root',
  });

  const message = await server.extractInstallStepFailureMessage(InstallStepKey.MiningLaunch);

  expect(connection.runCommandWithTimeout).toHaveBeenCalledWith('cat /root/logs/step-MiningLaunch.Failed', 10e3);
  expect(message).toContain('Server gateway did not become ready after 120 seconds');
});

it('preserves the existing Docker Compose project name when restarting the installer', async () => {
  const connection = {
    isDockerHostProxy: false,
    runCommandWithTimeout: vi
      .fn()
      .mockResolvedValueOnce(['COMPOSE_PROJECT_NAME=mainnet-existing\n', 0])
      .mockResolvedValue(['', 0]),
  };
  const server = new ServerAdmin(connection as any, {
    ipAddress: '127.0.0.1',
    sshUser: 'root',
    type: ServerType.CustomServer,
    workDir: '/root',
  });

  await server.startInstallerScript();

  expect(connection.runCommandWithTimeout).toHaveBeenCalledWith(
    expect.stringContaining('COMPOSE_PROJECT_NAME=mainnet-existing'),
    10e3,
  );
});

it('rejects an invalid existing Docker Compose project name', async () => {
  const connection = {
    isDockerHostProxy: false,
    runCommandWithTimeout: vi.fn().mockResolvedValueOnce(['COMPOSE_PROJECT_NAME=$(touch /tmp/injected)\n', 0]),
  };
  const server = new ServerAdmin(connection as any, {
    ipAddress: '127.0.0.1',
    sshUser: 'root',
    type: ServerType.CustomServer,
    workDir: '/root',
  });

  await expect(server.startInstallerScript()).rejects.toThrow('Invalid Docker Compose project name');
  expect(connection.runCommandWithTimeout).toHaveBeenCalledOnce();
});
