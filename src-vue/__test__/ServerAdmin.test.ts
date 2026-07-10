import { expect, it, vi } from 'vitest';
import { InstallStepKey, ServerType } from '../interfaces/IConfig.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';

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
