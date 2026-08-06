import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRuntimeCompatibility } from '../stores/runtimeCompatibility.ts';

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
