import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRuntimeCompatibility } from '../stores/runtimeCompatibility.ts';
import { createTypedEventEmitter } from '@argonprotocol/apps-core';

const findLastIndex = Array.prototype.findLastIndex;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', class ResizeObserver {});
});

afterEach(() => {
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    configurable: true,
    writable: true,
    value: findLastIndex,
  });
  vi.unstubAllGlobals();
});

it.each([
  ['AbortSignal.timeout', () => vi.stubGlobal('AbortSignal', class AbortSignal {})],
  [
    'Array.prototype.findLastIndex',
    () => {
      Object.defineProperty(Array.prototype, 'findLastIndex', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    },
  ],
  ['ResizeObserver', () => vi.stubGlobal('ResizeObserver', undefined)],
  ['crypto.subtle', () => vi.stubGlobal('crypto', {})],
])('hard-blocks the app when %s is unavailable', (_capability, removeCapability) => {
  const runtimeCompatibility = useRuntimeCompatibility();

  removeCapability();
  runtimeCompatibility.start();

  expect(runtimeCompatibility.phase).toBe('browser-unsupported');
  expect(runtimeCompatibility.shouldShowCompatibilityScreen).toBe(true);
});

it('keeps the existing compatibility behavior when browser capabilities are available', () => {
  const runtimeCompatibility = useRuntimeCompatibility();

  runtimeCompatibility.start();

  expect(runtimeCompatibility.phase).toBe('disabled');
  expect(runtimeCompatibility.shouldShowCompatibilityScreen).toBe(false);
});

it('leaves the initial compatibility screen after the offline grace period, even if requests never settle', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('__ARGON_APP_ENABLE_AUTOUPDATE__', true);
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  vi.doMock('../stores/mainchain.ts', () => ({
    getMainchainClients: () => ({
      archiveClientPromise: new Promise(() => undefined),
      events: createTypedEventEmitter(),
    }),
  }));
  const { useRuntimeCompatibility: useCompatibility } = await import('../stores/runtimeCompatibility.ts');
  const { useAppUpdater } = await import('../stores/appUpdater.ts');
  useAppUpdater().installedVersion = '2.5.1';
  const compatibility = useCompatibility();
  try {
    compatibility.start();
    expect(compatibility.shouldShowCompatibilityScreen).toBe(true);

    await vi.advanceTimersByTimeAsync(15_001);
    expect(compatibility.phase).toBe('compatible');
    expect(compatibility.shouldShowCompatibilityScreen).toBe(false);
    expect(compatibility.errorMessage).toContain('timed out');
  } finally {
    compatibility.$dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.doUnmock('../stores/mainchain.ts');
  }
});
