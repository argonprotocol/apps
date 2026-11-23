import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { createDeferred } from '@argonprotocol/apps-core';
import { RpcStats } from '../../core/src/RpcStats.ts';

const state = vi.hoisted(() => ({
  startup: undefined as unknown,
  controller: undefined as unknown,
  archiveClient: undefined as unknown,
  preferredClient: undefined as unknown,
}));
vi.mock('../stores/startup.ts', () => ({ useStartupStore: () => state.startup }));
vi.mock('../stores/certificationController.ts', () => ({ useCertificationController: () => state.controller }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => ({ isLoadedPromise: Promise.resolve() }) }));
vi.mock('../stores/mainchain.ts', () => ({
  getMiningFrames: () => ({ load: async () => undefined }),
  getMainchainClient: (historical: boolean) =>
    Promise.resolve(historical ? state.archiveClient : state.preferredClient),
}));
vi.mock('../stores/vaults.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../stores/vaults.ts')>()),
  getMyVault: () => {
    throw new Error('Vault loading is unavailable');
  },
}));

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

it('reports RPC failures without entering unavailable domain loading', async () => {
  vi.stubGlobal('__ARGON_DRIVER_WS__', 'ws://127.0.0.1:1');
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const archiveStats = new RpcStats();
  await archiveStats.request('chain_getHeader', [], false, async () => null);
  const stats = new RpcStats();
  await stats
    .request('state_call', ['TransactionPaymentApi_query_info', 'synthetic-payload'], false, async () => {
      throw new Error('Synthetic RPC timeout');
    })
    .catch(() => undefined);
  state.archiveClient = {
    get stats() {
      return { calls: archiveStats.snapshot() };
    },
  };
  state.preferredClient = {
    get stats() {
      return { calls: stats.snapshot() };
    },
  };
  const { runCommand } = await import('../e2e/commands.ts');

  const result = await runCommand('app.getRpcStats', { timeoutMs: 100 }, { session: 'synthetic' });

  expect(result).toMatchObject({
    ok: true,
    result: {
      preferredUsesArchive: false,
      archive: { calls: { methods: { chain_getHeader: { requests: 1, errors: 0 } } } },
      preferred: { calls: { methods: { 'state_call.TransactionPaymentApi_query_info': { requests: 1, errors: 1 } } } },
    },
  });
  expect(JSON.stringify(result)).not.toContain('synthetic-payload');

  state.preferredClient = new Promise(() => undefined);
  expect(await runCommand('app.getRpcStats', { timeoutMs: 10 }, { session: 'synthetic' })).toMatchObject({
    ok: false,
    error: { code: 'timeout' },
  });
});
