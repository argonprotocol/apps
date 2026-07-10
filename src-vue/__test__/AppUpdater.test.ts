import { beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { app } from '@tauri-apps/api';
import { check } from '@tauri-apps/plugin-updater';
import { isAppUpdateBlockingServerInstall, useAppUpdater } from '../stores/appUpdater.ts';

vi.mock('@tauri-apps/api', () => ({
  app: {
    getVersion: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}));

const sessionValues = new Map<string, string>();

beforeEach(() => {
  sessionValues.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => sessionValues.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => sessionValues.set(key, value)),
    removeItem: vi.fn((key: string) => sessionValues.delete(key)),
  });
});

it('blocks server installation across a UI reload after installing an app update', async () => {
  vi.mocked(app.getVersion).mockResolvedValue('1.4.2');
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
  vi.mocked(check).mockResolvedValue({
    version: '1.4.3',
    downloadAndInstall,
  } as any);
  const updater = useAppUpdater();

  await updater.checkForUpdates();
  await updater.downloadAndInstallUpdate();

  setActivePinia(createPinia());

  expect(useAppUpdater().isReadyToInstall).toBe(false);
  expect(await isAppUpdateBlockingServerInstall()).toBe(true);
  expect(sessionValues.get('argon-app-update-requires-relaunch')).toBe('1.4.3');

  vi.mocked(app.getVersion).mockResolvedValue('1.4.4');

  expect(await isAppUpdateBlockingServerInstall()).toBe(false);
  expect(sessionValues.has('argon-app-update-requires-relaunch')).toBe(false);
});
