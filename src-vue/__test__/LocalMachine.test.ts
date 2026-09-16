import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalMachine } from '../lib/LocalMachine.ts';

const { invokeWithTimeout, message } = vi.hoisted(() => ({
  invokeWithTimeout: vi.fn(),
  message: vi.fn(),
}));

vi.mock('../lib/tauriApi.ts', () => ({ invokeWithTimeout }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message }));

describe('LocalMachine', () => {
  beforeEach(() => {
    invokeWithTimeout.mockReset();
    message.mockReset();
  });

  it('returns without prompting for Docker when the local VM was removed', async () => {
    invokeWithTimeout.mockResolvedValueOnce(false);

    await expect(LocalMachine.activate()).resolves.toBeUndefined();

    expect(invokeWithTimeout).toHaveBeenCalledOnce();
    expect(invokeWithTimeout).toHaveBeenCalledWith('has_local_vm', {}, 10_000);
    expect(message).not.toHaveBeenCalled();
  });
});
