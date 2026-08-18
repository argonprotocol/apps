import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerType } from '../interfaces/IConfig.ts';
import { SSHConnection } from '../lib/SSHConnection.ts';
import { InvokeTimeout } from '../lib/tauriApi.ts';

const { invokeWithTimeout, listen, MockInvokeTimeout } = vi.hoisted(() => {
  class MockInvokeTimeout extends Error {}

  return {
    invokeWithTimeout: vi.fn(),
    listen: vi.fn(),
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
    listen,
  };
});

describe('SSHConnection', () => {
  beforeEach(() => {
    invokeWithTimeout.mockReset();
    listen.mockReset();
    listen.mockResolvedValue(vi.fn());
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

  it('retries an embedded upload after the transfer client times out', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    invokeWithTimeout
      .mockRejectedValueOnce(new Error('SSH upload timed out after 120s'))
      .mockResolvedValueOnce('success');

    const connection = new SSHConnection({
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      sshPort: 55404,
      sshUser: 'root',
      workDir: '/app',
    });

    await expect(
      connection.uploadEmbeddedFileWithTimeout(
        'resources/server-2.3.5.tar.gz',
        '/app/server-2.3.5.tar.gz',
        vi.fn(),
        120_000,
      ),
    ).resolves.toBeUndefined();

    expect(invokeWithTimeout.mock.calls.map(call => call[0] as string)).toEqual([
      'ssh_upload_embedded_file',
      'ssh_upload_embedded_file',
    ]);
    expect(warning).toHaveBeenCalledWith(
      '[SSHConnection] Embedded upload to /app/server-2.3.5.tar.gz timed out at 0%; retrying with a fresh transfer connection',
    );
    warning.mockRestore();
  });

  it('reports upload progress when the final transfer attempt times out', async () => {
    let emitProgress: ((event: { payload: number }) => void) | undefined;
    listen.mockImplementation(async (_eventName, callback) => {
      emitProgress = callback;
      return vi.fn();
    });
    invokeWithTimeout.mockImplementationOnce(async () => {
      emitProgress?.({ payload: 37 });
      throw new Error('SSH upload timed out after 120s');
    });

    const connection = new SSHConnection({
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      sshPort: 55404,
      sshUser: 'root',
      workDir: '/app',
    });

    await expect(
      connection.uploadEmbeddedFileWithTimeout(
        'resources/server-2.3.5.tar.gz',
        '/app/server-2.3.5.tar.gz',
        vi.fn(),
        120_000,
        0,
      ),
    ).rejects.toThrow('streaming, last progress 37%');
  });
});
