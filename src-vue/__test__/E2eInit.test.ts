import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BootstrapType, type IConfig } from '../interfaces/IConfig.ts';

const mocks = vi.hoisted(() => ({
  config: {
    isLoadedPromise: Promise.resolve(),
    showWelcomeOverlay: false,
    bootstrapDetails: undefined as IConfig['bootstrapDetails'],
    hasExtensionTreasury: false,
    hasExtensionOperations: false,
    save: vi.fn(),
  },
}));

vi.mock('../e2e/commands', () => ({
  LOGGABLE_ARG_KEYS: [],
  runCommand: vi.fn(),
}));

vi.mock('../stores/config', () => ({
  getConfig: () => mocks.config,
}));

import { initE2EClient, initializeE2EState } from '../e2e/init.ts';

beforeEach(() => {
  mocks.config.showWelcomeOverlay = false;
  mocks.config.bootstrapDetails = undefined;
  mocks.config.hasExtensionTreasury = false;
  mocks.config.hasExtensionOperations = false;
  mocks.config.save.mockClear();
});

it('activates E2E operations after access is available without bypassing the Treasury upgrade', async () => {
  await initializeE2EState();

  expect(mocks.config.hasExtensionTreasury).toBe(false);
  expect(mocks.config.hasExtensionOperations).toBe(true);
  expect(mocks.config.save).toHaveBeenCalledOnce();
});

it('keeps E2E extensions disabled while the first-run welcome overlay is shown', async () => {
  mocks.config.showWelcomeOverlay = true;

  await initializeE2EState();

  expect(mocks.config.hasExtensionTreasury).toBe(false);
  expect(mocks.config.hasExtensionOperations).toBe(false);
  expect(mocks.config.save).not.toHaveBeenCalled();
});

it('keeps a newly imported account at its recovered access level when automatic Operations access is disabled', async () => {
  await initializeE2EState(false);

  expect(mocks.config.hasExtensionTreasury).toBe(false);
  expect(mocks.config.hasExtensionOperations).toBe(false);
  expect(mocks.config.save).not.toHaveBeenCalled();
});

it('activates E2E operations after account import recreates the config database', async () => {
  mocks.config.showWelcomeOverlay = true;
  mocks.config.bootstrapDetails = { type: BootstrapType.Public, routerHost: '127.0.0.1' };

  await initializeE2EState();

  expect(mocks.config.showWelcomeOverlay).toBe(false);
  expect(mocks.config.hasExtensionTreasury).toBe(false);
  expect(mocks.config.hasExtensionOperations).toBe(true);
  expect(mocks.config.save).toHaveBeenCalledOnce();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preserves WebKit error messages and reports live RPC failures while ignoring transport teardown on unload', async () => {
  const messages: Record<string, unknown>[] = [];
  const sockets: EventTarget[] = [];
  class TestWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = TestWebSocket.OPEN;
    constructor() {
      super();
      sockets.push(this);
    }
    public send(message: string) {
      messages.push(JSON.parse(message));
    }
  }
  const browserWindow = new EventTarget();
  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('navigator', { clipboard: {} });
  vi.stubGlobal('WebSocket', TestWebSocket);
  vi.stubGlobal('__ARGON_DRIVER_WS__', 'ws://127.0.0.1:1/?session=fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await initE2EClient();
  sockets[0].dispatchEvent(new Event('open'));

  const historyError = new Error('Bitcoin Fission 1 history is missing its creation event');
  historyError.stack = 'restore@http://localhost/recovery.ts:1:1';
  console.error('[FinancialHistory] Unable to initialize recovery', historyError);
  expect(messages.at(-1)?.message).toContain(historyError.message);
  expect(messages.at(-1)?.message).toContain(historyError.stack);

  const transportError = new Error('ARCHIVE_RPC: WebSocket is not connected');
  browserWindow.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: transportError }));
  expect(messages.at(-1)).toMatchObject({ label: 'unhandledrejection', message: transportError.message });
  const beforeUnloadCount = messages.length;
  browserWindow.dispatchEvent(new Event('beforeunload'));
  browserWindow.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: transportError }));
  expect(messages).toHaveLength(beforeUnloadCount);

  browserWindow.dispatchEvent(
    Object.assign(new Event('unhandledrejection'), { reason: new Error('Unexpected failure') }),
  );
  expect(messages.at(-1)).toMatchObject({ label: 'unhandledrejection', message: 'Unexpected failure' });
});
