import './helpers/mocks.ts';
import { beforeAll, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { createMockedDbPromise } from './helpers/db';
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
import type PluginSql from '@tauri-apps/plugin-sql';

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

it('reserves the final recovery progress for applying and saving config', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  vi.spyOn(walletKeys, 'didWalletHavePreviousLife').mockResolvedValueOnce(true);
  let reportProgress: ((progressPct: number) => void) | undefined;
  let finishRecovery: ((value: Record<string, never>) => void) | undefined;
  const recoverAccount = vi.fn(
    onProgress =>
      new Promise<Record<string, never>>(resolve => {
        reportProgress = onProgress;
        finishRecovery = resolve;
      }),
  );
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys, recoverAccount);
  const loadPromise = config.load();
  await vi.waitFor(() => expect(reportProgress).toBeTypeOf('function'));

  reportProgress?.(50);
  expect(config.walletPreviousHistoryLoadPct).toBe(47.5);
  expect(config.isBootingUpPreviousWalletHistory).toBe(true);

  finishRecovery?.({});
  await loadPromise;

  expect(config.walletPreviousHistoryLoadPct).toBe(100);
  expect(config.isBootingUpPreviousWalletHistory).toBe(false);
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

it('treats saved mining seats as mining activity', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
    hasMiningBids: 'false',
    hasMiningSeats: 'true',
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(true);
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

it.each([VaultingSetupStatus.None, VaultingSetupStatus.Checklist, VaultingSetupStatus.Installing])(
  'recovers completed vault setup from %s when vaulting rules and an open vault were saved',
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

it('preserves established operation state when recreating the local database', async () => {
  const dbPromise = createMockedDbPromise({
    hasExtensionTreasury: 'true',
    hasExtensionOperations: 'true',
    miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
    vaultingSetupStatus: `"${VaultingSetupStatus.Finished}"`,
    isServerInstalled: 'true',
    hasMiningBids: 'true',
    hasMiningSeats: 'true',
    walletAccountsHadPreviousLife: 'true',
    walletPreviousLifeRecovered: 'true',
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  const replacementConnection = {} as PluginSql;
  await config.restoreToConnection(replacementConnection);

  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.vaultingSetupStatus).toBe(VaultingSetupStatus.Finished);
  expect(config.isServerInstalled).toBe(true);
  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(true);
  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.walletPreviousLifeRecovered).toBe(true);
  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
      vaultingSetupStatus: `"${VaultingSetupStatus.Finished}"`,
      isServerInstalled: 'true',
      hasMiningBids: 'true',
      hasMiningSeats: 'true',
      walletAccountsHadPreviousLife: 'true',
      walletPreviousLifeRecovered: 'true',
    }),
    replacementConnection,
  );
});

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
