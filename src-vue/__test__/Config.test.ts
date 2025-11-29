import './helpers/mocks.ts';
import { beforeAll, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { createMockedDbPromise } from './helpers/db';
import { instanceChecks } from '../lib/Utils.js';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestWallet } from './helpers/wallet.ts';

beforeAll(() => {
  WalletKeys.prototype.didWalletHavePreviousLife = vi.fn().mockResolvedValue(false);
});

it('can load config defaults', async () => {
  const dbPromise = createMockedDbPromise();
  instanceChecks.delete(Config.prototype.constructor);

  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  expect(config.isMinerReadyToInstall).toBe(false);
  expect(config.isMinerInstalled).toBe(false);
  expect(config.isMinerUpToDate).toBe(false);
  expect(config.hasMiningSeats).toBe(false);
  expect(config.hasMiningBids).toBe(false);
  expect(config.biddingRules).toBeTruthy();
});

it('can load config from db state', async () => {
  const dbPromise = createMockedDbPromise({ isMinerInstalled: 'true' });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  expect(config.isMinerInstalled).toBe(true);
});
