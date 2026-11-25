import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createVNode } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { invoke } from '@tauri-apps/api/core';
import { readDir } from '@tauri-apps/plugin-fs';
import DebugPackage from '../overlays/troubleshooting/DebugPackage.vue';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('{}') }));
vi.mock('@tauri-apps/api/path', () => ({
  appLogDir: async () => '/logs',
  downloadDir: async () => '/downloads',
  tempDir: async () => '/temp',
  join: async (...parts: string[]) => path.posix.join(...parts),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: async () => undefined }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn().mockResolvedValue([]),
  copyFile: async () => undefined,
  mkdir: async () => undefined,
  remove: async () => undefined,
  writeTextFile: async () => undefined,
}));
vi.mock('../stores/config.ts', () => ({ getConfig: vi.fn() }));
vi.mock('../stores/wallets.ts', () => ({ getWalletKeys: vi.fn() }));
vi.mock('../lib/Diagnostics.ts', () => ({ Diagnostics: vi.fn() }));
vi.mock('../lib/Utils.ts', () => ({ getInstanceConfigDir: async () => '/config' }));
vi.mock('../lib/Env.ts', () => ({ INSTANCE_NAME: 'test-instance', LOG_FILE_PREFIX: 'test-instance' }));

it('includes current and retained native log rotations for only this instance in the support archive', async () => {
  const fileNames = [
    'test-instance.log',
    'test-instance_2026-11-25_12-00-00.log',
    'test-instance_2026-11-25_12-00-00_1.log',
    'test-instance_2026-11-25_12-00-00_12.log',
    'test-instance_2026-11-24_12-00-00.log.bak',
    'other-instance_2026-11-25_12-00-00_1.log',
    'test-instance-other.log',
    'test-instance_2026-11-25_12-00-00_notes.log',
    'test-instance_2026-11-25_12-00-00_1.log.zip',
  ];
  vi.mocked(readDir).mockImplementation(async dir => {
    if (dir !== '/logs') return [];
    return [
      ...fileNames.map(name => ({ name, isFile: true, isDirectory: false, isSymlink: false })),
      { name: 'test-instance_2026-11-25_12-00-00_2.log', isFile: false, isDirectory: true, isSymlink: false },
    ];
  });

  const vnode = createVNode(DebugPackage, { includeServer: false });
  await renderToString(vnode);
  const component = (vnode.component as any).setupState as Record<string, unknown>;
  const downloadTroubleshooting = component.downloadTroubleshooting as () => Promise<void>;
  await downloadTroubleshooting();

  const archiveRequest = vi.mocked(invoke).mock.calls.find(([command]) => command === 'create_zip')?.[1] as
    | Record<string, unknown>
    | undefined;
  const archivedPaths = archiveRequest?.pathsWithPrefixes as [string, string][];
  expect(archivedPaths.filter(([prefix]) => prefix === 'logs')).toEqual([
    ['logs', '/logs/test-instance.log'],
    ['logs', '/logs/test-instance_2026-11-25_12-00-00.log'],
    ['logs', '/logs/test-instance_2026-11-25_12-00-00_1.log'],
    ['logs', '/logs/test-instance_2026-11-25_12-00-00_12.log'],
    ['logs', '/logs/test-instance_2026-11-24_12-00-00.log.bak'],
  ]);
  expect(component.savedPackagePath).toMatch(/^\/downloads\/argon_test-instance_troubleshooting_\d+\.zip$/);
  expect(component.isCreatingTroubleshootingPackage).toBe(false);
  expect(component.troubleshootingError).toBe('');
});
