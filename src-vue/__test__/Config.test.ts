import './helpers/mocks.ts';
import { beforeAll, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { createMockedDbPromise, createTestDb } from './helpers/db';
import { instanceChecks } from '../lib/Utils.js';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestWallet } from './helpers/wallet.ts';
import {
  BootstrapType,
  MiningSetupStatus,
  OnboardingSetupStatus,
  ServerType,
  VaultingSetupStatus,
} from '../interfaces/IConfig.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import Restarter from '../lib/Restarter.ts';
import PluginSql from '@tauri-apps/plugin-sql';
import { LocalMachine } from '../lib/LocalMachine.ts';

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
  expect(config.onboardingSetupStatus).toBe(OnboardingSetupStatus.None);
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

it('keeps Crosschain Transfers available after it has been activated', async () => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db), walletKeys);
  await config.load();

  config.hasActivatedCrosschain = true;
  await config.save();

  instanceChecks.delete(Config.prototype.constructor);
  const restoredConfig = new Config(Promise.resolve(db), walletKeys);
  await restoredConfig.load();

  expect(restoredConfig.hasActivatedCrosschain).toBe(true);
  await db.close();
});

it('does not recover operation state from cached mining or vault activity', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Checklist}"`,
    vaultingSetupStatus: `"${VaultingSetupStatus.Installing}"`,
    hasMiningBids: 'false',
    hasMiningSeats: 'true',
    vaultingRules: JsonExt.stringify(Config.getDefault('vaultingRules'), 2),
  });
  const db = await dbPromise;
  const miningActivitySpy = vi
    .spyOn(db, 'select')
    .mockRejectedValue(new Error('cached mining activity should not be queried'));
  const vaultActivitySpy = vi
    .spyOn(db.vaultsTable, 'get')
    .mockRejectedValue(new Error('cached vault activity should not be queried'));
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(miningActivitySpy).not.toHaveBeenCalled();
  expect(vaultActivitySpy).not.toHaveBeenCalled();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.vaultingSetupStatus).toBe(VaultingSetupStatus.Installing);
  expect(config.hasMiningBids).toBe(false);
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

it('does not activate a recovered local server owned by another app instance', async () => {
  const dbPromise = createMockedDbPromise({
    serverDetails: JsonExt.stringify({
      ipAddress: '127.0.0.1',
      sshPort: 55116,
      sshUser: 'argon',
      type: ServerType.LocalComputer,
      workDir: '/app',
    }),
    isServerInstalled: 'true',
  });
  const activate = vi.spyOn(LocalMachine, 'activate');
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(activate).not.toHaveBeenCalled();
  expect(config.serverDetails.sshPort).toBe(55116);
});

it.each(['loading', 'ARGON_NETWORK_NAME'])('clears fake upstream state stored with %s', async routerHost => {
  const dbPromise = createMockedDbPromise({
    bootstrapDetails: JsonExt.stringify({ type: BootstrapType.Public, routerHost }),
    upstreamOperator: JsonExt.stringify({ name: 'Fake upstream' }),
  });
  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);

  await config.load();

  expect(config.bootstrapDetails).toBeUndefined();
  expect(config.upstreamOperator).toBeUndefined();
  expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ bootstrapDetails: '', upstreamOperator: '' }));
});

it.each([
  { vaultReadState: 'readable vault', vaultReadFails: false },
  { vaultReadState: 'damaged vault table', vaultReadFails: true },
])('preserves established operation state when recreating the local database with a $vaultReadState', async params => {
  const { vaultReadFails } = params;
  const db = await createTestDb();
  const replacementDb = await createTestDb();
  const miningHistory = [{ frameId: 10, bids: [], seats: [] }];
  const pluginSqlLoad = vi.spyOn(PluginSql, 'load').mockResolvedValue(replacementDb.sql);

  try {
    await db.configTable.insertOrReplace({
      bootstrapDetails: JsonExt.stringify({ type: BootstrapType.Public, routerHost: 'custom-router' }, 2),
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
      vaultingSetupStatus: `"${VaultingSetupStatus.Finished}"`,
      onboardingSetupStatus: `"${OnboardingSetupStatus.Finished}"`,
      isServerInstalled: 'true',
      hasMiningBids: 'true',
      hasMiningSeats: 'true',
      walletAccountsHadPreviousLife: 'true',
      walletPreviousLifeRecovered: 'true',
      miningBotAccountPreviousHistory: JsonExt.stringify(miningHistory),
    });
    await db.vaultsTable.insert({
      id: 1,
      hdPath: '//vaulting',
      createdAtBlockHeight: 10,
      lastTermsUpdateHeight: 20,
      operationalFeeMicrogons: 30n,
      isClosed: false,
    });
    const { walletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db), walletKeys);
    await config.load();

    if (vaultReadFails) {
      vi.spyOn(db.vaultsTable, 'get').mockRejectedValue(new Error('vault table is unreadable'));
    }

    const previousLifeSpy = vi.spyOn(walletKeys, 'didWalletHavePreviousLife');
    const restarter = new Restarter(Promise.resolve(db), config);
    vi.spyOn(restarter, 'deleteAndCreateLocalDatabase').mockResolvedValue();
    vi.spyOn(restarter, 'restart').mockImplementation(() => undefined);
    await restarter.migrateToFreshLocalDatabase();

    const recoverAccount = vi.fn(async () => ({}));
    const { walletKeys: restoredWalletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const restoredConfig = new Config(Promise.resolve(replacementDb), restoredWalletKeys, recoverAccount);
    await restoredConfig.load();

    expect(previousLifeSpy).not.toHaveBeenCalled();
    expect(recoverAccount).not.toHaveBeenCalled();
    expect(restoredConfig.isBootingUpPreviousWalletHistory).toBe(false);
    expect(restoredConfig.hasExtensionTreasury).toBe(true);
    expect(restoredConfig.hasExtensionOperations).toBe(true);
    expect(restoredConfig.bootstrapDetails).toEqual({
      type: BootstrapType.Public,
      routerHost: 'custom-router',
    });
    expect(restoredConfig.miningSetupStatus).toBe(MiningSetupStatus.Finished);
    expect(restoredConfig.vaultingSetupStatus).toBe(VaultingSetupStatus.Finished);
    expect(restoredConfig.onboardingSetupStatus).toBe(OnboardingSetupStatus.Finished);
    expect(restoredConfig.isServerInstalled).toBe(true);
    expect(restoredConfig.hasMiningBids).toBe(true);
    expect(restoredConfig.hasMiningSeats).toBe(true);
    expect(restoredConfig.walletAccountsHadPreviousLife).toBe(true);
    expect(restoredConfig.walletPreviousLifeRecovered).toBe(true);
    expect(restoredConfig.miningBotAccountPreviousHistory).toEqual(miningHistory);

    const restoredVault = await replacementDb.vaultsTable.get();
    if (vaultReadFails) {
      expect(restoredVault).toBeUndefined();
    } else {
      expect(restoredVault).toEqual(
        expect.objectContaining({
          id: 1,
          hdPath: '//vaulting',
          createdAtBlockHeight: 10,
          lastTermsUpdateHeight: 20,
          operationalFeeMicrogons: 30n,
          isClosed: false,
        }),
      );
    }
  } finally {
    pluginSqlLoad.mockRestore();
    await db.close();
    await replacementDb.close();
  }
});
