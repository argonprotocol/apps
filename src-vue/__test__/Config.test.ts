import './helpers/mocks.ts';
import { expect, it, vi } from 'vitest';
import { Config } from '../lib/Config';
import { AppStartup } from '../lib/AppStartup.ts';
import type { WalletRecovery } from '../lib/WalletRecovery.ts';
import type { MainchainClients } from '@argonprotocol/apps-core';
import { createMockedDbPromise, createTestDb, createTestDbAtMigration } from './helpers/db';
import { instanceChecks } from '../lib/Utils.js';
import { createTestWallet } from './helpers/wallet.ts';
import {
  BootstrapType,
  MiningSetupStatus,
  OnboardingSetupStatus,
  ServerType,
  TopTab,
  VaultingSetupStatus,
} from '../interfaces/IConfig.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import Restarter from '../lib/Restarter.ts';
import PluginSql from '@tauri-apps/plugin-sql';
import { LocalMachine } from '../lib/LocalMachine.ts';
import { AdvancedRestartOption } from '../interfaces/IAdvancedRestartOption.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';

const getStartupClient = vi.fn();
const startupClients = { get: getStartupClient } as unknown as MainchainClients;

it('can load config defaults', async () => {
  const dbPromise = createMockedDbPromise();
  instanceChecks.delete(Config.prototype.constructor);

  const config = new Config(dbPromise);
  await config.load();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.None);
  expect(config.onboardingSetupStatus).toBe(OnboardingSetupStatus.None);
  expect(config.isServerInstalling).toBe(false);
  expect(config.hasMiningSeats).toBe(false);
  expect(config.hasMiningBids).toBe(false);
  expect(config.biddingRules).toBeTruthy();
  expect(config.postWelcomeLaunchCount).toBe(0);
  expect(config.hasConnectedDiscord).toBe(false);
  expect(config.returnMetric).toBe('RTD');
});

it('restores the selected return metric after restart', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();

  config.returnMetric = 'APY';
  await config.save();

  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(db));
  await restarted.load();
  expect(restarted.returnMetric).toBe('APY');
  await db.close();
});

it('publishes replaced secret ciphertext only after commit and keeps it through later saves', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();
  config.serverAdd = { digitalOcean: { encryptedApiKey: 'encrypted-service-before' } };
  await config.save();

  try {
    const replacements = { 'encrypted-service-before': 'encrypted-service-after' };
    await expect(
      db.transaction(async transaction => {
        await config.replaceEncryptedSecrets(replacements, transaction);
        expect(config.readEncryptedSecrets()).toEqual({ digitalOceanApiKey: 'encrypted-service-before' });
        throw new Error('Abort the settings change');
      }),
    ).rejects.toThrow('Abort the settings change');
    expect(config.serverAdd?.digitalOcean?.encryptedApiKey).toBe('encrypted-service-before');
    expect(JsonExt.parse((await db.configTable.fetchAllAsObject()).serverAdd!)).toEqual(config.serverAdd);

    // A dirty serverAdd must not later overwrite the replacement with its old serialized ciphertext.
    config.serverAdd = { ...config.serverAdd, localComputer: {} };
    config.selectedTab = TopTab.Mining;
    await db.transaction(async transaction => {
      await config.replaceEncryptedSecrets(replacements, transaction);
      expect(config.serverAdd?.digitalOcean?.encryptedApiKey).toBe('encrypted-service-before');
    });
    expect(config.readEncryptedSecrets()).toEqual({ digitalOceanApiKey: 'encrypted-service-after' });
    expect(config.serverAdd?.localComputer).toEqual({});

    await config.save();
    const stored = await db.configTable.fetchAllAsObject();
    expect(JsonExt.parse(stored.serverAdd!)).toEqual(config.serverAdd);
    expect(JsonExt.parse(stored.selectedTab!)).toBe(TopTab.Mining);
  } finally {
    await db.close();
  }
});

it('persists backed-up certification details without requesting mnemonic deletion', async () => {
  const db = await createTestDb();
  const nativeCommands = vi.mocked(invokeWithTimeout);
  nativeCommands.mockClear();

  try {
    await db.configTable.insertOrReplace({
      certificationDetails: JsonExt.stringify({ hasSavedMnemonic: true, showBonusTooltip: true }),
    });
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();

    config.setCertificationDetails({ showBonusTooltip: false });
    await config.save();

    expect(JsonExt.parse((await db.configTable.fetchAllAsObject()).certificationDetails!)).toMatchObject({
      hasSavedMnemonic: true,
      showBonusTooltip: false,
    });
    expect(nativeCommands).not.toHaveBeenCalledWith('cleanup_mnemonic_files', expect.anything(), expect.anything());
  } finally {
    nativeCommands.mockClear();
    await db.close();
  }
});

it.each([
  VaultingSetupStatus.None,
  VaultingSetupStatus.Checklist,
  VaultingSetupStatus.Installing,
  VaultingSetupStatus.Finished,
])('migrates vault creation choices and status across restart: %s', async status => {
  const { db, migrateToLatest } = await createTestDbAtMigration(37);
  const oldRules = {
    baseMicrogonCommitment: 3_000_000_000n,
    baseMicronotCommitment: 5_000_000n,
    securitizationRatio: 1.5,
    btcFlatFee: 3_000_000n,
    btcPctFee: 4.5,
    capitalForSecuritizationPct: 90,
    capitalForTreasuryPct: 10,
    profitSharingPct: 37,
  };
  await db.configTable.insertOrReplace({
    vaultingSetupStatus: JsonExt.stringify(status),
    vaultingRules: JsonExt.stringify(oldRules),
  } as Record<string, string>);
  await migrateToLatest();
  const expected = {
    securitizationMicrogons: 3_000_000_000n,
    committedMicronots: 5_000_000n,
    securitizationRatio: 1.5,
    btcFlatFee: 3_000_000n,
    btcPctFee: 4.5,
  };
  const stored = await db.configTable.fetchAllAsObject();
  expect(JsonExt.parse(stored.vaultSetup!)).toEqual(expected);
  expect(stored).not.toHaveProperty('vaultingRules');

  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();
  const { securitizationRatio: _obsoleteRatio, ...currentChoices } = expected;
  expect(config.vaultSetup).toEqual(currentChoices);
  expect(config.vaultingSetupStatus).toBe(status);
  expect(config.hasSavedVaultSetup).toBe(true);

  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(db));
  await restarted.load();
  expect(restarted.vaultSetup).toEqual(currentChoices);
  expect(restarted.vaultingSetupStatus).toBe(status);
  await db.close();
});

it('can load config from db state', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Finished}"`,
    postWelcomeLaunchCount: '4',
  });
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.postWelcomeLaunchCount).toBe(4);
});

it('keeps Crosschain Transfers available after it has been activated', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();

  config.hasActivatedCrosschain = true;
  await config.save();

  instanceChecks.delete(Config.prototype.constructor);
  const restoredConfig = new Config(Promise.resolve(db));
  await restoredConfig.load();

  expect(restoredConfig.hasActivatedCrosschain).toBe(true);
  await db.close();
});

it('remembers that Discord was connected after config reloads', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();

  config.hasConnectedDiscord = true;
  await config.save();

  instanceChecks.delete(Config.prototype.constructor);
  const restoredConfig = new Config(Promise.resolve(db));
  await restoredConfig.load();

  expect(restoredConfig.hasConnectedDiscord).toBe(true);
  await db.close();
});

it('persists unchanged vault fees when retrying a failed settings write', async () => {
  const db = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();
  config.vaultSetup.btcFlatFee = 2_000_000n;
  await config.saveVaultSetup();

  config.vaultSetup.btcFlatFee = 3_000_000n;
  vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('Synthetic settings write failure'));
  await expect(config.saveVaultSetup()).rejects.toThrow('Synthetic settings write failure');
  await config.saveVaultSetup();

  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(db));
  await restarted.load();
  expect(restarted.vaultSetup.btcFlatFee).toBe(3_000_000n);
  await db.close();
});

it('does not recover operation state from cached mining or vault activity', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: `"${MiningSetupStatus.Checklist}"`,
    vaultingSetupStatus: `"${VaultingSetupStatus.Installing}"`,
    hasMiningBids: 'false',
    hasMiningSeats: 'true',
    vaultSetup: JsonExt.stringify(Config.getDefault('vaultSetup'), 2),
  });
  const db = await dbPromise;
  const miningActivitySpy = vi
    .spyOn(db, 'select')
    .mockRejectedValue(new Error('cached mining activity should not be queried'));
  const vaultActivitySpy = vi
    .spyOn(db.vaultsTable, 'get')
    .mockRejectedValue(new Error('cached vault activity should not be queried'));
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

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
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

  await config.load();

  expect(config.serverDetails.sshPort).toBe(2222);
  expect((config.serverDetails as any).port).toBeUndefined();
});

it.each(['loading', 'ARGON_NETWORK_NAME'])('clears fake upstream state stored with %s', async routerHost => {
  const dbPromise = createMockedDbPromise({
    bootstrapDetails: JsonExt.stringify({ type: BootstrapType.Public, routerHost }),
    upstreamOperator: JsonExt.stringify({ name: 'Fake upstream' }),
  });
  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

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
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();

    if (vaultReadFails) {
      vi.spyOn(db.vaultsTable, 'get').mockRejectedValue(new Error('vault table is unreadable'));
    }

    const restarter = new Restarter(Promise.resolve(db), config);
    vi.spyOn(restarter, 'deleteAndCreateLocalDatabase').mockResolvedValue();
    vi.spyOn(restarter, 'restart').mockImplementation(() => undefined);
    await restarter.migrateToFreshLocalDatabase();

    const recoverAccount = vi.fn(async () => ({}));
    const { walletKeys: restoredWalletKeys } = createTestWallet('//Alice');
    const previousLifeSpy = getStartupClient;
    previousLifeSpy.mockClear();
    instanceChecks.delete(Config.prototype.constructor);
    const restoredConfig = new Config(Promise.resolve(replacementDb));
    const restoredStartup = new AppStartup(restoredConfig, restoredWalletKeys, startupClients);
    await restoredStartup.initialize();
    await restoredStartup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery);

    expect(previousLifeSpy).not.toHaveBeenCalled();
    expect(recoverAccount).not.toHaveBeenCalled();
    expect(restoredStartup.isRecoveringHistory).toBe(false);
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

it('preserves connected Ethereum wallets when recreating the local database', async () => {
  const db = await createTestDb();
  const replacementDb = await createTestDb();
  const pluginSqlLoad = vi.spyOn(PluginSql, 'load').mockResolvedValue(replacementDb.sql);

  try {
    await db.walletsTable.createDefaultEthereum({
      address: '0x1111111111111111111111111111111111111111',
      derivationPath: "m/44'/60'/0'/0'/0'",
    });
    await db.walletsTable.importExternalEthereum({
      name: 'Imported Ethereum',
      address: '0x2222222222222222222222222222222222222222',
      coreEthereumAddress: '0x1111111111111111111111111111111111111111',
      derivationPath: "m/44'/60'/0'/0'/7'",
      secretKind: 'mnemonic',
      encryptedSecret: 'encrypted-wallet-secret',
    });
    const originalWallets = await db.walletsTable.fetchEthereumWallets();

    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();

    const restarter = new Restarter(Promise.resolve(db), config);
    vi.spyOn(restarter, 'deleteAndCreateLocalDatabase').mockResolvedValue();
    vi.spyOn(restarter, 'restart').mockImplementation(() => undefined);

    await restarter.migrateToFreshLocalDatabase();

    expect(await replacementDb.walletsTable.fetchEthereumWallets()).toEqual(originalWallets);
  } finally {
    pluginSqlLoad.mockRestore();
    await db.close();
    await replacementDb.close();
  }
});

it('recreates a wiped local server instead of restoring its removed VM connection', async () => {
  const db = await createTestDb();
  const replacementDb = await createTestDb();
  const pluginSqlLoad = vi.spyOn(PluginSql, 'load').mockResolvedValue(replacementDb.sql);
  const activate = vi.spyOn(LocalMachine, 'activate').mockResolvedValue({ sshPort: 56285 });

  try {
    await db.configTable.insertOrReplace({
      serverAdd: JsonExt.stringify({ localComputer: {} }, 2),
      serverDetails: JsonExt.stringify(
        {
          ipAddress: '127.0.0.1',
          sshPort: 56285,
          sshUser: 'argon',
          type: ServerType.LocalComputer,
          workDir: '/app',
        },
        2,
      ),
      isServerInstalled: 'true',
      certificationDetails: JsonExt.stringify({
        hasSavedMnemonic: true,
        dismissedWelcomeToOperationsOverlay: true,
      }),
    });
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    activate.mockClear();

    const restarter = new Restarter(Promise.resolve(db), config);
    vi.spyOn(restarter, 'getServer').mockResolvedValue({ completelyWipeEverything: vi.fn() } as any);
    vi.spyOn(restarter, 'deleteAndCreateLocalDatabase').mockResolvedValue();
    vi.spyOn(restarter, 'restart').mockImplementation(() => undefined);

    await restarter.run(
      new Set([
        AdvancedRestartOption.CompletelyWipeAndReinstallCloudMachine,
        AdvancedRestartOption.RecreateLocalDatabase,
        AdvancedRestartOption.ReloadAppUi,
      ]),
      { stop: vi.fn() } as any,
    );

    instanceChecks.delete(Config.prototype.constructor);
    const restoredConfig = new Config(Promise.resolve(replacementDb));
    await restoredConfig.load();

    expect(restoredConfig.serverAdd).toEqual({ localComputer: {} });
    expect(restoredConfig.serverDetails).toEqual(Config.getDefault('serverDetails'));
    expect(restoredConfig.isServerInstalled).toBe(false);
    expect(restoredConfig.certificationDetails).toEqual({
      hasSavedMnemonic: true,
      dismissedWelcomeToOperationsOverlay: true,
    });
    expect(activate).not.toHaveBeenCalled();
  } finally {
    activate.mockRestore();
    pluginSqlLoad.mockRestore();
    await db.close();
    await replacementDb.close();
  }
});

it('preserves a wiped remote server connection for reinstallation', async () => {
  const db = await createTestDb();
  const replacementDb = await createTestDb();
  const pluginSqlLoad = vi.spyOn(PluginSql, 'load').mockResolvedValue(replacementDb.sql);
  const serverDetails = {
    ipAddress: '203.0.113.10',
    sshUser: 'root',
    type: ServerType.DigitalOcean,
    workDir: '~',
  };
  const serverAdd = { digitalOcean: { encryptedApiKey: 'encrypted-token' } };

  try {
    await db.configTable.insertOrReplace({
      serverAdd: JsonExt.stringify(serverAdd, 2),
      serverDetails: JsonExt.stringify(serverDetails, 2),
      isServerInstalled: 'true',
    });
    const { walletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();

    const restarter = new Restarter(Promise.resolve(db), config);
    vi.spyOn(restarter, 'getServer').mockResolvedValue({ completelyWipeEverything: vi.fn() } as any);
    vi.spyOn(restarter, 'deleteAndCreateLocalDatabase').mockResolvedValue();
    vi.spyOn(restarter, 'restart').mockImplementation(() => undefined);

    await restarter.run(
      new Set([
        AdvancedRestartOption.CompletelyWipeAndReinstallCloudMachine,
        AdvancedRestartOption.RecreateLocalDatabase,
        AdvancedRestartOption.ReloadAppUi,
      ]),
      { stop: vi.fn() } as any,
    );

    instanceChecks.delete(Config.prototype.constructor);
    const restoredConfig = new Config(Promise.resolve(replacementDb));
    await restoredConfig.load();

    expect(restoredConfig.serverDetails).toEqual(serverDetails);
    expect(restoredConfig.serverAdd).toEqual(serverAdd);
    expect(restoredConfig.isServerInstalled).toBe(false);
  } finally {
    pluginSqlLoad.mockRestore();
    await db.close();
    await replacementDb.close();
  }
});
