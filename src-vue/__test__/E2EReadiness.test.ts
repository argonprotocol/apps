import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { createDeferred } from '@argonprotocol/apps-core';

const state = vi.hoisted(() => ({ startup: undefined as unknown, controller: undefined as unknown }));
vi.mock('../stores/startup.ts', () => ({ useStartupStore: () => state.startup }));
vi.mock('../stores/certificationController.ts', () => ({ useCertificationController: () => state.controller }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => ({ isLoadedPromise: Promise.resolve() }) }));
vi.mock('../stores/mainchain.ts', () => ({ getMiningFrames: () => ({ load: async () => undefined }) }));

afterEach(() => vi.unstubAllGlobals());

it('does not report a loaded Config as ready before startup and the main UI are ready', async () => {
  const startup = reactive({ startup: { isReady: false }, errorMessage: '' });
  const controllerReady = createDeferred<void>(false);
  state.startup = startup;
  state.controller = { isLoadedPromise: controllerReady.promise };
  vi.stubGlobal('window', { setTimeout, clearTimeout, __ARGON_E2E_VISUALS__: false });
  vi.stubGlobal('document', { querySelectorAll: () => [] });
  const { runCommand } = await import('../e2e/commands.ts');
  expect(
    await runCommand(
      'ui.isVisible',
      { testId: 'AccountAuthenticationOverlay', readyTimeoutMs: 50 },
      { session: 'synthetic' },
    ),
  ).toMatchObject({ ok: true });
  let settled = false;
  const waiting = runCommand('app.waitForReady', { timeoutMs: 1_000 }, { session: 'synthetic' }).then(result => {
    settled = true;
    return result;
  });

  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    startup.startup.isReady = true;
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    controllerReady.resolve();
    expect(await waiting).toMatchObject({ ok: true });
  } finally {
    startup.startup.isReady = true;
    controllerReady.resolve();
    await waiting;
  }
});
