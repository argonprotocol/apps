import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerType } from '../interfaces/IConfig.ts';
import { SSHConnection } from '../lib/SSHConnection.ts';
import { InvokeTimeout } from '../lib/tauriApi.ts';

const { invokeWithTimeout, MockInvokeTimeout } = vi.hoisted(() => {
  class MockInvokeTimeout extends Error {}

  return {
    invokeWithTimeout: vi.fn(),
    MockInvokeTimeout,
  };
});

vi.mock('../lib/tauriApi.ts', () => {
  return {
    InvokeTimeout: MockInvokeTimeout,
    invokeWithTimeout,
  };
});

vi.mock('@tauri-apps/api/event', () => {
  return {
    listen: vi.fn(),
  };
});

describe('SSHConnection', () => {
  beforeEach(() => {
    invokeWithTimeout.mockReset();
  });

  it('reconnects after a command timeout even if close times out', async () => {
    invokeWithTimeout
      .mockResolvedValueOnce('success')
      .mockRejectedValueOnce(new InvokeTimeout('command timed out'))
      .mockRejectedValueOnce(new InvokeTimeout('close timed out'))
      .mockResolvedValueOnce('success')
      .mockResolvedValueOnce(['ok', 0]);

    const connection = new SSHConnection({
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      sshPort: 55404,
      sshUser: 'root',
      workDir: '/app',
    });

    await connection.connect(0);

    await expect(connection.runCommandWithTimeout('pwd', 10_000)).resolves.toEqual(['ok', 0]);

    expect(invokeWithTimeout.mock.calls.map(call => call[0] as string)).toEqual([
      'open_ssh_connection',
      'ssh_run_command',
      'close_ssh_connection',
      'open_ssh_connection',
      'ssh_run_command',
    ]);
  });

  it('reconnects when the SSH pool no longer has the connection', async () => {
    invokeWithTimeout
      .mockResolvedValueOnce('success')
      .mockRejectedValueOnce('No SSH connection')
      .mockResolvedValueOnce('success')
      .mockResolvedValueOnce('success')
      .mockResolvedValueOnce(['ok', 0]);

    const connection = new SSHConnection({
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      sshPort: 55404,
      sshUser: 'root',
      workDir: '/app',
    });

    await connection.connect(0);

    await expect(connection.runCommandWithTimeout('ls /app/logs', 10_000)).resolves.toEqual(['ok', 0]);

    expect(invokeWithTimeout.mock.calls.map(call => call[0] as string)).toEqual([
      'open_ssh_connection',
      'ssh_run_command',
      'close_ssh_connection',
      'open_ssh_connection',
      'ssh_run_command',
    ]);
  });
});
