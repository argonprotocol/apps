import './helpers/mocks.ts';
import { beforeAll, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { createMockedDbPromise, createTestDb } from './helpers/db';
import { instanceChecks } from '../lib/Utils.js';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestWallet } from './helpers/wallet.ts';
import {
  type IConfig,
  InstallStepStatus,
  MiningSetupStatus,
  ServerType,
  VaultingSetupStatus,
} from '../interfaces/IConfig.ts';
import { JsonExt } from '@argonprotocol/apps-core';

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
  expect(config.postWelcomeLaunchCount).toBe(0);
});

it('keeps mnemonic-restored accounts eligible for financial history without mining or vault history', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  vi.spyOn(walletKeys, 'didWalletHavePreviousLife').mockResolvedValueOnce(true);
  const recoverAccount = vi.fn(async () => ({}));
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys, recoverAccount);

  await config.load();

  expect(recoverAccount).toHaveBeenCalledOnce();
  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.walletPreviousLifeRecovered).toBe(true);
});

it('can load config from db state', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
    postWelcomeLaunchCount: '4',
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.postWelcomeLaunchCount).toBe(4);
});

it('trusts saved mining seats without querying cached activity', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
    hasMiningBids: 'false',
    hasMiningSeats: 'true',
  });
  const db = await dbPromise;
  vi.spyOn(db, 'select').mockRejectedValue(new Error('cached mining activity should not be queried'));
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(true);
});

it('restores established mining flags from cached activity on app restart', async () => {
  const db = await createTestDb();
  const biddingRules = Config.getDefault('biddingRules') as IConfig['biddingRules'];
  biddingRules.initialCapitalCommitment = 1n;
  await db.configTable.insertOrReplace({
    miningSetupStatus: `"${MiningSetupStatus.Installing}"`,
    isServerInstalled: 'true',
    isServerInstalling: 'true',
    hasMiningBids: 'false',
    hasMiningSeats: 'false',
    biddingRules: JsonExt.stringify(biddingRules),
  });
  await db.frameBidsTable.insertOrUpdate(20, 200, [
    {
      address: '5cachedBid',
      subAccountIndex: 1,
      microgonsPerSeat: 10n,
      micronotsStakedPerSeat: 20n,
      bidPosition: 0,
      lastBidAtTick: 100,
    },
  ]);
  await db.framesTable.insertOrUpdate({
    id: 19,
    firstTick: 1,
    rewardTicksRemaining: 0,
    firstBlockNumber: 100,
    lastBlockNumber: 199,
    microgonToUsd: [],
    microgonToBtc: [],
    microgonToArgonot: [],
    accruedMicrogonProfits: 0n,
    accruedMicronotProfits: 0n,
    progress: 100,
  });
  await db.cohortsTable.insertOrUpdate({
    id: 19,
    transactionFeesTotal: 0n,
    micronotsStakedPerSeat: 20n,
    microgonsBidPerSeat: 10n,
    seatCountWon: 1,
    microgonsToBeMinedPerSeat: 30n,
    micronotsToBeMinedPerSeat: 40n,
    argonotPriceAtBid: 50n,
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db), walletKeys);

  try {
    await config.load();

    expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
    expect(config.hasMiningBids).toBe(true);
    expect(config.hasMiningSeats).toBe(true);
    await expect(db.configTable.fetchAllAsObject()).resolves.toEqual(
      expect.objectContaining({
        miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
        hasMiningBids: 'true',
        hasMiningSeats: 'true',
      }),
    );
  } finally {
    await db.close();
    instanceChecks.delete(db.constructor);
  }
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

it.each([MiningSetupStatus.Checklist, MiningSetupStatus.Installing])(
  'finishes interrupted mining setup from %s when bidding rules and the server were already saved',
  async miningSetupStatus => {
    const biddingRules = Config.getDefault('biddingRules') as IConfig['biddingRules'];
    biddingRules.initialCapitalCommitment = 1n;
    const serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
    serverInstaller.MiningLaunch.status = InstallStepStatus.Completed;
    const dbPromise = createMockedDbPromise({
      miningSetupStatus: `"${miningSetupStatus}"`,
      isServerInstalled: 'true',
      biddingRules: JsonExt.stringify(biddingRules),
      serverInstaller: JsonExt.stringify(serverInstaller),
    });
    const db = await dbPromise;
    const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
    const { walletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(dbPromise, walletKeys);

    await config.load();

    expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ miningSetupStatus: `"${MiningSetupStatus.Finished}"` }),
    );
  },
);

it('keeps mining setup active while the final server install step is still running', async () => {
  const biddingRules = Config.getDefault('biddingRules') as IConfig['biddingRules'];
  biddingRules.initialCapitalCommitment = 1n;
  const serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
  serverInstaller.MiningLaunch.status = InstallStepStatus.Working;
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Installing}"`,
    isServerInstalled: 'true',
    isServerInstalling: 'true',
    biddingRules: JsonExt.stringify(biddingRules),
    serverInstaller: JsonExt.stringify(serverInstaller),
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Installing);
});

it.each([VaultingSetupStatus.Checklist, VaultingSetupStatus.Installing])(
  'finishes interrupted vault setup from %s when vaulting rules and a vault were already saved',
  async vaultingSetupStatus => {
    const dbPromise = createMockedDbPromise({
      vaultingSetupStatus: `"${vaultingSetupStatus}"`,
      vaultingRules: JsonExt.stringify(Config.getDefault('vaultingRules')),
    });
    const db = await dbPromise;
    vi.spyOn(db.vaultsTable, 'get').mockResolvedValue({
      id: 1,
      hdPath: '//1',
      createdAtBlockHeight: 10,
      isClosed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
    const { walletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(dbPromise, walletKeys);

    await config.load();

    expect(config.vaultingSetupStatus).toBe(VaultingSetupStatus.Finished);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ vaultingSetupStatus: `"${VaultingSetupStatus.Finished}"` }),
    );
  },
);

it('keeps interrupted setup active without durable evidence that creation finished', async () => {
  const biddingRules = Config.getDefault('biddingRules') as IConfig['biddingRules'];
  biddingRules.initialCapitalCommitment = 0n;
  const serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
  serverInstaller.MiningLaunch.status = InstallStepStatus.Completed;
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Checklist}"`,
    isServerInstalled: 'true',
    vaultingSetupStatus: `"${VaultingSetupStatus.Installing}"`,
    biddingRules: JsonExt.stringify(biddingRules),
    vaultingRules: JsonExt.stringify(Config.getDefault('vaultingRules')),
    serverInstaller: JsonExt.stringify(serverInstaller),
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.vaultingSetupStatus).toBe(VaultingSetupStatus.Installing);
});
