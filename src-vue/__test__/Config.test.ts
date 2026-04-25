import './helpers/mocks.ts';
import { beforeAll, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { createMockedDbPromise } from './helpers/db';
import { instanceChecks } from '../lib/Utils.js';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { MiningSetupStatus, ServerType } from '../interfaces/IConfig.ts';

beforeAll(() => {
  WalletKeys.prototype.didWalletHavePreviousLife = vi.fn().mockResolvedValue(false);
});

it('can load config defaults', async () => {
  const dbPromise = createMockedDbPromise();
  instanceChecks.delete(Config.prototype.constructor);

  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.None);
  expect(config.isServerInstalling).toBe(false);
  expect(config.hasMiningSeats).toBe(false);
  expect(config.hasMiningBids).toBe(false);
  expect(config.biddingRules).toBeTruthy();
});

it('can load config from db state', async () => {
  const dbPromise = createMockedDbPromise({ miningSetupStatus: `"${MiningSetupStatus.Finished}"` });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
});

it('migrates old server port field to sshPort', async () => {
  const dbPromise = createMockedDbPromise({
    serverDetails: JSON.stringify({
      ipAddress: '127.0.0.1',
      port: 2222,
      sshUser: 'root',
      type: ServerType.CustomServer,
      workDir: '~',
    }),
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.serverDetails.sshPort).toBe(2222);
  expect((config.serverDetails as any).port).toBeUndefined();
});
