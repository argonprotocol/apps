import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { message } from '@tauri-apps/plugin-dialog';
import { check, Update } from '@tauri-apps/plugin-updater';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', async importOriginal => ({
  ...(await importOriginal<typeof import('@tauri-apps/plugin-updater')>()),
  check: vi.fn(),
}));
vi.mock('../lib/Env.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/Env.ts')>()),
  ENABLE_AUTO_UPDATE: true,
}));

let pinia: Pinia;

beforeEach(() => {
  vi.resetModules();
  pinia = createPinia();
  setActivePinia(pinia);
  vi.mocked(check).mockReset().mockResolvedValue(null);
  vi.mocked(message).mockReset().mockResolvedValue('Ok');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  disposePinia(pinia);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('shares an update offer across errors without showing a fatal alert after dismissal', async () => {
  const { useAppUpdater } = await import('../stores/appUpdater.ts');
  const { default: handleFatalError } = await import('../stores/helpers/handleFatalError.ts');
  vi.mocked(check).mockResolvedValue(new Update({ rid: 1, currentVersion: '2.6.0', version: '2.6.1', rawJson: {} }));
  const failure = new Error('Runtime changed during a read');
  const updater = useAppUpdater();
  const fatalRecovery = handleFatalError.call('getMyMiningSeats', failure);
  const concurrentRecovery = updater.showUpdateAfterError();

  await vi.waitFor(() => expect(updater.isOpen).toBe(true));
  expect(updater.update?.version).toBe('2.6.1');
  expect(message).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalledTimes(1);

  updater.isOpen = false;
  await Promise.all([fatalRecovery, concurrentRecovery]);
  expect(message).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith('Fatal error (getMyMiningSeats): ', failure);
  expect(updater.isOpen).toBe(false);
});

it.each(['unavailable', 'failed'])('keeps restart recovery when the update check is %s', async result => {
  const { useAppUpdater } = await import('../stores/appUpdater.ts');
  const { default: handleFatalError } = await import('../stores/helpers/handleFatalError.ts');
  if (result === 'failed') vi.mocked(check).mockRejectedValue(new Error('Update service unavailable'));

  await handleFatalError.call('appStartup', new Error('Application load failed'));

  expect(useAppUpdater().isOpen).toBe(false);
  expect(message).toHaveBeenCalledWith('A fatal error (appStartup) has occurred. Please restart the application.', {
    title: 'Fatal Error',
    kind: 'error',
  });
});

it('keeps a later error behind an update opened during the error-check cooldown', async () => {
  vi.useFakeTimers();
  const { useAppUpdater } = await import('../stores/appUpdater.ts');
  const { default: handleFatalError } = await import('../stores/helpers/handleFatalError.ts');
  const updater = useAppUpdater();
  await updater.showUpdateAfterError();

  vi.mocked(check).mockResolvedValue(new Update({ rid: 1, currentVersion: '2.6.0', version: '2.6.1', rawJson: {} }));
  await updater.checkForUpdates();
  updater.isOpen = true;
  const recovery = handleFatalError.call('appStartup', new Error('Application load failed again'));

  await vi.advanceTimersByTimeAsync(0);
  expect(message).not.toHaveBeenCalled();

  updater.isOpen = false;
  await recovery;
  expect(message).not.toHaveBeenCalled();
});

it('bounds a stalled error check and can offer a newly published update after the cooldown', async () => {
  vi.useFakeTimers();
  const { useAppUpdater } = await import('../stores/appUpdater.ts');
  const { default: handleFatalError } = await import('../stores/helpers/handleFatalError.ts');
  vi.mocked(check).mockImplementationOnce(() => new Promise(() => undefined));
  const updater = useAppUpdater();
  const recovery = handleFatalError.call('appStartup', new Error('Application load failed'));

  await vi.advanceTimersByTimeAsync(30_001);
  await recovery;
  expect(message).toHaveBeenCalledTimes(1);
  expect(updater.isChecking).toBe(false);
  expect(updater.isOpen).toBe(false);

  await updater.showUpdateAfterError();
  expect(check).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(30_000);
  vi.mocked(check).mockResolvedValue(new Update({ rid: 2, currentVersion: '2.6.0', version: '2.6.1', rawJson: {} }));
  const nextRecovery = updater.showUpdateAfterError();
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.isOpen).toBe(true);
  updater.isOpen = false;
  await nextRecovery;
});
