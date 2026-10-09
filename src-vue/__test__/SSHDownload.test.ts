import { expect, it, vi } from 'vitest';
import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event';
import { SSHConnection } from '../lib/SSHConnection.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';
import { ServerType } from '../interfaces/IConfig.ts';

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn<(event: string, handler: EventCallback<number>) => Promise<UnlistenFn>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: async () => '/tmp',
  join: async (...parts: string[]) => parts.join('/'),
}));

it('keeps a progressing download alive past one minute and releases its progress listener', async () => {
  vi.useFakeTimers();
  const unsubscribe = vi.fn();
  const progress = vi.fn<(percent: number) => void>();
  listen.mockResolvedValue(unsubscribe);
  invoke.mockImplementation(command => {
    if (command === 'ssh_run_command') return Promise.resolve(['[✓] Bundle ready: /tmp/diagnostics.tar.gz', 0]);
    if (command === 'ssh_download_file') return new Promise(resolve => setTimeout(() => resolve('success'), 90e3));
    throw new Error(`Unexpected native command: ${command}`);
  });
  const details = {
    type: ServerType.CustomServer,
    ipAddress: '127.0.0.1',
    sshUser: 'argon',
    workDir: '~',
  };
  const connection = new SSHConnection(details);
  try {
    const transfer = new ServerAdmin(connection, details).downloadTroubleshootingPackage(progress);
    const result = transfer.then(
      () => 'downloaded',
      error => String(error),
    );
    await vi.advanceTimersByTimeAsync(30e3);
    listen.mock.calls[0][1]({ event: 'download', id: 1, payload: 30 });
    await vi.advanceTimersByTimeAsync(40e3);
    listen.mock.calls[0][1]({ event: 'download', id: 1, payload: 70 });
    await vi.advanceTimersByTimeAsync(20e3);
    expect(await result).toBe('downloaded');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
