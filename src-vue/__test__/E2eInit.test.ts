import { beforeEach, expect, it, vi } from 'vitest';
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

import { initializeE2EState } from '../e2e/init.ts';

beforeEach(() => {
  mocks.config.showWelcomeOverlay = false;
  mocks.config.bootstrapDetails = undefined;
  mocks.config.hasExtensionTreasury = false;
  mocks.config.hasExtensionOperations = false;
  mocks.config.save.mockClear();
});

it('activates E2E extensions after access is available', async () => {
  await initializeE2EState();

  expect(mocks.config.hasExtensionTreasury).toBe(true);
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

it('activates E2E extensions after account import recreates the config database', async () => {
  mocks.config.showWelcomeOverlay = true;
  mocks.config.bootstrapDetails = { type: BootstrapType.Public, routerHost: '127.0.0.1' };

  await initializeE2EState();

  expect(mocks.config.showWelcomeOverlay).toBe(false);
  expect(mocks.config.hasExtensionTreasury).toBe(true);
  expect(mocks.config.hasExtensionOperations).toBe(true);
  expect(mocks.config.save).toHaveBeenCalledOnce();
});
