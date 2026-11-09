import './helpers/mocks.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import Path from 'node:path';
import { tmpdir } from 'node:os';
import { createPinia, setActivePinia } from 'pinia';
import PluginSql from '@tauri-apps/plugin-sql';
import { remove } from '@tauri-apps/plugin-fs';
import { confirm } from '@tauri-apps/plugin-dialog';
import { EncryptionSecret } from '../lib/EncryptionSecret.ts';
import { WalletSecrets } from '../lib/WalletSecrets.ts';
import {
  AccountActivityKind,
  createDeferred,
  JsonExt,
  Mining,
  Vault,
  miniSecretFromUri,
} from '@argonprotocol/apps-core';
import Importer from '../lib/Importer.ts';
import { Config } from '../lib/Config.ts';
import { AppStartup } from '../lib/AppStartup.ts';
import type { WalletRecovery } from '../lib/WalletRecovery.ts';
import type { MainchainClients } from '@argonprotocol/apps-core';
import { createMockedDbPromise, createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { SSH } from '../lib/SSH.ts';
import { type IConfig, MiningSetupStatus, OnboardingSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import Restarter from '../lib/Restarter.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { hexToU8a } from '@argonprotocol/mainchain';

const startupClients = { get: vi.fn() } as unknown as MainchainClients;
const keychain = vi.hoisted(() => ({ value: '', sql: undefined as PluginSql | undefined }));
let importDirectory: string;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: any) => {
    if (command === 'keychain_info') return { method: 'none' };
    if (command === 'keychain_write') {
      keychain.value = args.value;
      return;
    }
    if (command === 'keychain_create') {
      keychain.value = Buffer.from(args.key).toString('hex');
      return;
    }
    if (command === 'sql_start_transaction_session') return;
    if (command === 'sql_execute_write') return keychain.sql!.execute(args.query, args.values);
    if (command === 'keychain_encrypt') return 'synthetic-encrypted-mnemonic';
    if (command === 'keychain_decrypt')
      return EncryptionSecret.decryptWithKey(Buffer.from(keychain.value, 'hex'), args.ciphertexts);
    throw new Error(`Unexpected native command: ${command}`);
  }),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn() } }));
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { AppConfig: 1 }, remove: vi.fn() }));
vi.mock('../stores/runtimeCompatibility.ts', () => ({
  useRuntimeCompatibility: () => ({ start: () => undefined, shouldShowCompatibilityScreen: false }),
}));

const importMocks = vi.hoisted(() => ({
  closeWallets: vi.fn(),
  findMiningActivity: vi.fn(),
  getFinalizedClient: vi.fn(),
  getMainchainClient: vi.fn(),
  getOperatorVaultId: vi.fn(),
  readBalances: vi.fn(),
  stopBlockWatch: vi.fn(),
  getConfig: vi.fn(),
  getDbPromise: vi.fn(),
  getWalletKeys: vi.fn(),
  useWallets: vi.fn(),
}));

vi.mock('../stores/config.ts', async importOriginal => ({
  ...(await importOriginal()),
  getConfig: importMocks.getConfig,
}));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: importMocks.getDbPromise }));

vi.mock('../stores/mainchain.ts', () => ({
  getFinalizedClient: importMocks.getFinalizedClient,
  getMainchainClient: importMocks.getMainchainClient,
  getBlockWatch: () => ({ stop: importMocks.stopBlockWatch }),
}));

vi.mock('../stores/wallets.ts', () => ({
  getWalletsForArgon: () => ({ close: importMocks.closeWallets }),
  getWalletKeys: importMocks.getWalletKeys,
  useWallets: importMocks.useWallets,
}));

vi.mock('../lib/WalletsForArgon.ts', async importOriginal => ({
  ...(await importOriginal()),
  readArgonWalletBalanceValues: importMocks.readBalances,
}));

vi.mock('../lib/IndexerClient.ts', () => ({
  findAddressActivity: importMocks.findMiningActivity,
}));

const testJurisdiction = {
  ipAddress: '',
  city: '',
  region: '',
  countryName: '',
  countryCode: '',
  latitude: '',
  longitude: '',
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(confirm).mockResolvedValue(true);
  importDirectory = await fs.mkdtemp(Path.join(tmpdir(), 'argon-import-'));
  keychain.value = '';
  keychain.sql = undefined;
  vi.mocked(invokeWithTimeout).mockImplementation(async (command, args) => {
    const filename = args.filename && Path.join(importDirectory, args.filename);
    if (command === 'read_wallet_file') return fs.readFile(filename, 'utf8').catch(() => null);
    if (command === 'write_wallet_file') return fs.writeFile(filename, args.contents);
    if (command === 'delete_wallet_file') return fs.rm(filename, { force: true });
  });
  importMocks.getOperatorVaultId.mockResolvedValue(null);
  importMocks.getMainchainClient.mockResolvedValue({
    tx: { operationalAccounts: { setName: vi.fn() } },
  });
});

afterEach(async () => {
  await keychain.sql?.close();
  vi.unstubAllGlobals();
  await fs.rm(importDirectory, { recursive: true, force: true });
});

async function createImporterConfig(walletKeys: WalletKeys) {
  const db = await createTestDb();
  await db.configTable.insertOrReplace({
    showWelcomeOverlay: 'true',
    userJurisdiction: JsonExt.stringify(testJurisdiction, 2),
  });
  const dbPromise = Promise.resolve(db);
  vi.spyOn(db, 'reconnect').mockResolvedValue();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();

  return { config, db, dbPromise };
}

it('rejects oversized mnemonic cleanup before parsing its entries or changing saved state', async () => {
  const savedWallet = JSON.stringify({ encryptedMnemonic: 'saved-account-ciphertext' });
  const pending = JSON.stringify({
    wallet: { encryptedMnemonic: 'incoming-account-ciphertext' },
    keychainValue: '37'.repeat(32),
    encryptedMnemonicCleanup: [null, null, null],
    config: {},
  });
  await fs.writeFile(Path.join(importDirectory, 'wallet.json'), savedWallet);
  await fs.writeFile(Path.join(importDirectory, 'wallet.tmp.json'), pending);

  await expect(Importer.finishPendingImport()).rejects.toMatchObject({
    issues: [
      {
        code: 'custom',
        path: ['encryptedMnemonicCleanup'],
        message: 'An account import can remove at most two mnemonics.',
      },
    ],
  });
  expect(keychain.value).toBe('');
  expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(savedWallet);
  expect(await fs.readFile(Path.join(importDirectory, 'wallet.tmp.json'), 'utf8')).toBe(pending);
});

it('stops background sync before importing and keeps the current database on failure', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.mocked(invokeWithTimeout).mockRejectedValueOnce(new Error('import failed'));
  const deleteDatabase = vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();

  await expect(new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic)).rejects.toThrow(
    'import failed',
  );

  expect(invokeWithTimeout).toHaveBeenCalledWith('backup_current_instance_database_for_import', {}, 30_000);
  expect(importMocks.closeWallets).toHaveBeenCalledOnce();
  expect(importMocks.stopBlockWatch).toHaveBeenCalledOnce();
  expect(importMocks.stopBlockWatch.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(invokeWithTimeout).mock.invocationCallOrder[0],
  );
  expect(deleteDatabase).not.toHaveBeenCalled();
});

it.each([
  { interruption: 'deletion', activity: 'unused' },
  { interruption: 'deletion', activity: 'history' },
  { interruption: 'migration', activity: 'funds' },
  { interruption: 'cleanup', activity: 'history' },
] as const)(
  'finishes a staged import after $interruption is interrupted ($activity account)',
  async ({ interruption, activity }) => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const previousMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const { walletKeys } = createTestWallet(previousMnemonic);
    const previousKey = Buffer.alloc(32, 0x37);
    const databasePath = Path.join(importDirectory, 'database.sqlite');
    const db = await createTestDb(databasePath);
    await db.walletsTable.upsertDefaultArgon({ address: walletKeys.defaultArgonAddress, keyReference: '//vaulting' });
    await db.framesTable.insertOrUpdate({
      id: 42,
      firstTick: 1,
      rewardTicksRemaining: 0,
      firstBlockNumber: 1,
      lastBlockNumber: 2,
      microgonToUsd: [],
      microgonToBtc: [],
      microgonToArgonot: [],
      progress: 100,
    });
    await db.execute('UPDATE Frames SET isProcessed = 1 WHERE id = 42');
    await db.framesTable.loadState();
    expect(db.framesTable.state.processedFrames[42]).toBe(true);
    await db.configTable.insertOrReplace({
      showWelcomeOverlay: 'true',
      userJurisdiction: JsonExt.stringify(testJurisdiction),
    });
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    config.walletAccountsHadPreviousLife = activity === 'history';
    importMocks.getConfig.mockReturnValue(config);
    importMocks.getDbPromise.mockReturnValue(Promise.resolve(db));
    importMocks.getWalletKeys.mockReturnValue(walletKeys);
    const externalBalances = createDeferred<void>();
    const wallets = {
      hasFunds: false as boolean | undefined,
      isLoadedPromise: Promise.resolve(),
      externalBalancesReady: externalBalances.promise,
    };
    if (activity !== 'funds') externalBalances.resolve();
    importMocks.useWallets.mockReturnValue(wallets);
    const [encryptedMnemonic, encryptedEthereumKey, encryptedApiKey] = await EncryptionSecret.encryptWithKey(
      previousKey,
      [previousMnemonic, `0x${'01'.repeat(32)}`, 'synthetic-digitalocean-token'],
    );
    await db.walletsTable.importExternalEthereum({
      address: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1',
      coreEthereumAddress: walletKeys.coreEthereumAddress,
      secretKind: 'privateKey',
      encryptedSecret: encryptedEthereumKey,
    });
    config.serverAdd = { digitalOcean: { encryptedApiKey } };
    await config.save();
    const previousWallet = JSON.stringify({ encryptedMnemonic, meta: WalletKeys.deriveIdentity(previousMnemonic) });
    await fs.writeFile(Path.join(importDirectory, 'wallet.json'), previousWallet);
    keychain.value = previousKey.toString('hex');
    const previousMnemonicPath = Path.join(importDirectory, 'mnemonic-backups', 'previous-account', 'mnemonic');
    const incomingMnemonicPath = Path.join(importDirectory, 'mnemonic');
    const unrelatedMnemonicPath = Path.join(importDirectory, 'mnemonic-backups', 'unconfirmed-account', 'mnemonic');
    await fs.mkdir(Path.dirname(previousMnemonicPath), { recursive: true });
    await fs.mkdir(Path.dirname(unrelatedMnemonicPath), { recursive: true });
    await fs.writeFile(previousMnemonicPath, previousMnemonic);
    await fs.writeFile(incomingMnemonicPath, mnemonic);
    await fs.writeFile(unrelatedMnemonicPath, 'unconfirmed recovery material');

    const uncommitted = await WalletSecrets.prepareWallet(mnemonic, WalletKeys.deriveIdentity(mnemonic));
    expect(JSON.stringify(uncommitted)).not.toContain(
      Buffer.from(hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`))).toString('hex'),
    );
    expect(uncommitted).not.toHaveProperty('keychainValue');
    await fs.writeFile(
      Path.join(importDirectory, 'wallet.tmp.json.tmp'),
      JSON.stringify({ ...uncommitted, config: {} }),
    );
    await Importer.finishPendingImport({ dbPromise: Promise.resolve(db), config });
    await expect(fs.stat(Path.join(importDirectory, 'wallet.tmp.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(keychain.value).toBe(previousKey.toString('hex'));
    expect((await db.walletsTable.getDefaultArgon())?.address).toBe(walletKeys.defaultArgonAddress);

    importMocks.getFinalizedClient.mockResolvedValue({
      query: {
        operationalAccounts: { operationalAccounts: vi.fn().mockResolvedValue(null) },
        vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      },
    });
    importMocks.readBalances.mockResolvedValue([
      emptyBalance,
      emptyBalance,
      { ...emptyBalance, availableMicrogons: 1n },
      emptyBalance,
    ]);
    importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
    vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
    vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);
    const exposeMnemonic = vi.spyOn(walletKeys, 'exposeMasterMnemonic');
    setActivePinia(createPinia());
    const { useStartupStore } = await import('../stores/startup.ts');
    const importing = useStartupStore();
    let interruptReset = true;
    let failStartupReset = false;
    vi.mocked(remove).mockImplementation(async () => {
      if (interruptReset) expect(importing.isImporting).toBe(true);
      if (interruptReset && interruption === 'deletion') throw new Error('Synthetic interrupted database replacement');
      await fs.unlink(databasePath);
    });
    vi.spyOn(PluginSql, 'load').mockImplementation(async () => {
      // Match Tauri's path-based pool replacement and idempotent close.
      await keychain.sql?.close();
      const sql = (await createTestDbAtMigration(0, databasePath)).db.sql;
      const close = sql.close.bind(sql);
      let closed = false;
      vi.spyOn(sql, 'close').mockImplementation(async () => {
        if (!closed) await close();
        closed = true;
        return true;
      });
      keychain.sql = sql;
      return sql;
    });

    const native = vi.mocked(invokeWithTimeout).getMockImplementation()!;
    vi.mocked(invokeWithTimeout).mockImplementation(async (command, args, timeout) => {
      if (command === 'cleanup_mnemonic_files') {
        if (interruptReset && interruption === 'cleanup') throw new Error('Synthetic interrupted database replacement');
        const committed = JSON.parse(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8'));
        expect(
          await EncryptionSecret.decryptWithKey(Buffer.from(keychain.value, 'hex'), [committed.encryptedMnemonic]),
        ).toEqual([mnemonic]);
        for (const path of [previousMnemonicPath, incomingMnemonicPath, unrelatedMnemonicPath]) {
          if ((await fs.readFile(path, 'utf8').catch(() => null)) === args.mnemonic) await fs.unlink(path);
        }
        return;
      }
      if (command === 'run_db_migrations') {
        if (interruptReset && interruption === 'migration')
          throw new Error('Synthetic interrupted database replacement');
        if (failStartupReset && keychain.sql) {
          failStartupReset = false;
          throw new Error('Synthetic interrupted startup replay');
        }
        if (!(await fs.stat(databasePath).catch(() => null))) {
          const migrated = await createTestDb(databasePath);
          await migrated.close();
        }
        return;
      }
      return native(command, args, timeout);
    });

    let expectedFailure = 'Synthetic interrupted database replacement';
    if (interruption === 'cleanup') expectedFailure = 'Could not remove old mnemonic files.';
    if (activity === 'unused') {
      wallets.hasFunds = undefined;
      await expect(importing.importFromMnemonic(mnemonic)).rejects.toThrow(
        'Could not check your existing account balances. Reload the app before replacing it.',
      );
      expect(keychain.value).toBe(previousKey.toString('hex'));
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);
      wallets.hasFunds = false;
    }
    if (interruption === 'cleanup') {
      vi.mocked(confirm).mockResolvedValueOnce(false);
      await expect(importing.importFromMnemonic(mnemonic)).resolves.toBe(false);
      expect(importing.isImporting).toBe(false);
      expect(keychain.value).toBe(previousKey.toString('hex'));
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);
      expect(await db.walletsTable.fetchEthereumWallets()).toHaveLength(1);
      vi.mocked(confirm).mockClear();
    }
    if (activity === 'unused') {
      vi.spyOn(EncryptionSecret.prototype, 'create').mockRejectedValueOnce(
        new Error('Synthetic keychain write failure'),
      );
      await expect(importing.importFromMnemonic(mnemonic)).rejects.toThrow('Synthetic keychain write failure');
      expect(keychain.value).toBe(previousKey.toString('hex'));
      const staged = await fs.readFile(Path.join(importDirectory, 'wallet.tmp.json'), 'utf8');
      expect(staged).not.toContain(previousKey.toString('hex'));
      expect(staged).not.toContain(miniSecretFromUri(`${mnemonic}//wallet-encryption`).slice(2));
      await expect(Importer.finishPendingImport({ dbPromise: Promise.resolve(db), config })).resolves.toBe(false);
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);
    }
    const importResult = expect(importing.importFromMnemonic(mnemonic)).rejects.toThrow(expectedFailure);
    if (activity === 'funds') {
      await vi.waitFor(() => expect(importMocks.useWallets).toHaveBeenCalled());
      expect(keychain.value).toBe(previousKey.toString('hex'));
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);
      wallets.hasFunds = true;
      externalBalances.resolve();
    }
    await importResult;
    expect(importing.isImporting).toBe(false);
    if (activity === 'unused') {
      expect(confirm).not.toHaveBeenCalled();
      expect(exposeMnemonic).not.toHaveBeenCalled();
    } else {
      expect(confirm).toHaveBeenCalledOnce();
      expect(exposeMnemonic).toHaveBeenCalledOnce();
    }
    const pending = JSON.parse(await fs.readFile(Path.join(importDirectory, 'wallet.tmp.json'), 'utf8'));
    expect(pending.keychainValue).toBeUndefined();
    expect(pending.wallet.protection).toBe('none');
    const nextKey = hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`));
    expect(JSON.stringify(pending)).not.toContain(Buffer.from(nextKey).toString('hex'));
    expect(JSON.stringify(pending)).not.toContain(previousKey.toString('hex'));
    await expect(WalletSecrets.readSavedWallet()).rejects.toThrow('An account import is still pending');
    expect(
      await EncryptionSecret.decryptWithKey(nextKey, [
        pending.wallet.encryptedMnemonic,
        ...pending.encryptedMnemonicCleanup,
      ]),
    ).toEqual(activity === 'unused' ? [mnemonic] : [mnemonic, mnemonic, previousMnemonic]);
    await expect(EncryptionSecret.decryptWithKey(previousKey, [pending.wallet.encryptedMnemonic])).rejects.toThrow();
    if (interruption !== 'cleanup')
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);
    expect(await fs.readFile(previousMnemonicPath, 'utf8')).toBe(previousMnemonic);
    expect(await fs.readFile(incomingMnemonicPath, 'utf8')).toBe(mnemonic);
    expect(JSON.stringify(pending)).not.toContain(previousMnemonic);
    expect(JSON.stringify(pending)).not.toContain(mnemonic);

    // A webview reload keeps the native process alive: startup itself must repair schema and discard old caches.
    interruptReset = false;
    failStartupReset = true;
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    setActivePinia(createPinia());
    instanceChecks.delete(Config.prototype.constructor);
    const startup = useStartupStore();
    await expect(startup.initialize()).rejects.toThrow('Synthetic interrupted startup replay');
    expect(startup.errorMessage).toBe('Your account could not be opened. Please try again.');
    expect(startup.isWalletReady).toBe(false);
    expect(startup.bot).toBeUndefined();
    await startup.initialize();
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(Path.join(importDirectory, 'wallet.tmp.json'), 'utf8')).wallet).toEqual(
      pending.wallet,
    );
    if (interruption !== 'cleanup')
      expect(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8')).toBe(previousWallet);

    setActivePinia(createPinia());
    const freshStartup = useStartupStore();
    await freshStartup.initialize();
    expect(freshStartup.errorMessage).toBe('');
    expect(freshStartup.isWalletReady).toBe(false);
    expect(freshStartup.bot).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(2);
    const reopened = (await createTestDbAtMigration(0, databasePath)).db;
    instanceChecks.delete(Config.prototype.constructor);
    const restartedConfig = new Config(Promise.resolve(reopened));
    await restartedConfig.load();
    expect(restartedConfig.showWelcomeOverlay).toBe(false);
    expect(restartedConfig.certificationDetails?.hasSavedMnemonic).toBe(true);
    expect(await reopened.walletsTable.getDefaultArgon()).toBeUndefined();
    expect(await reopened.walletsTable.fetchEthereumWallets()).toEqual([]);
    expect(restartedConfig.readEncryptedSecrets()).toEqual({});
    expect(restartedConfig.isServerAdded).toBe(false);
    expect(JSON.parse(await fs.readFile(Path.join(importDirectory, 'wallet.json'), 'utf8'))).toEqual(pending.wallet);
    if (activity === 'unused') {
      expect(await fs.readFile(previousMnemonicPath, 'utf8')).toBe(previousMnemonic);
      expect(await fs.readFile(incomingMnemonicPath, 'utf8')).toBe(mnemonic);
    } else {
      await expect(fs.stat(previousMnemonicPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(incomingMnemonicPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await fs.readFile(unrelatedMnemonicPath, 'utf8')).toBe('unconfirmed recovery material');
    await expect(fs.stat(Path.join(importDirectory, 'wallet.tmp.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const address = WalletKeys.deriveIdentity(mnemonic).vaultingAddress;
    await reopened.walletsTable.upsertDefaultArgon({ address, keyReference: '//vaulting' });
    const committedKey = keychain.value;
    await reopened.close();
    const nextStartup = (await createTestDbAtMigration(0, databasePath)).db;
    instanceChecks.delete(Config.prototype.constructor);
    await Importer.finishPendingImport();
    expect((await nextStartup.walletsTable.getDefaultArgon())?.address).toBe(address);
    expect(keychain.value).toBe(committedKey);
    await nextStartup.close();
  },
);

it('restores completed mining setup from imported operational account state', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  const operationalDetails = {
    accountBitcoinAmount: 0n,
    accountVaultBondAmount: 0n,
    availableAccessCodes: 0,
    isOperationallyCertified: false,
    miningSeatAccrual: 0,
    miningSeatAppliedTotal: 1,
    name: null,
    operationalCertificationsCount: 0,
    rewardsCollectedAmount: 0n,
    rewardsEarnedAmount: 0n,
    rewardsEarnedCount: 0,
    uniswapArgonTransfersInAmount: 0n,
    upstreamAccount: null,
    vaultBitcoinAccrual: 0n,
    vaultBitcoinAppliedTotal: 0n,
    vaultCreated: true,
  };
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(operationalDetails),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockImplementation(async (_api, addresses: string[]) => {
    expect(addresses).toEqual([
      importWalletKeys.legacyMiningHoldAddress,
      importWalletKeys.miningBotAddress,
      importWalletKeys.vaultingAddress,
      importWalletKeys.operationalAddress,
    ]);
    return [emptyBalance, emptyBalance, { ...emptyBalance, availableMicrogons: 1n }, emptyBalance];
  });
  const fetchMiningSeats = vi.spyOn(Mining, 'fetchMiningSeatsForAccount');
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.certificationDetails?.hasSavedMnemonic).toBe(true);
  expect(config.certificationDetails?.dismissedWelcomeToOperationsOverlay).toBe(true);
  expect(config.certificationDetails?.dismissedOperationsActivatedOverlay).toBe(true);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      showWelcomeOverlay: 'false',
      walletAccountsHadPreviousLife: 'true',
      walletPreviousLifeRecovered: 'false',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      hasActivatedCrosschain: 'false',
      certificationDetails: JsonExt.stringify(
        {
          hasSavedMnemonic: true,
          dismissedWelcomeToOperationsOverlay: true,
          dismissedOperationsActivatedOverlay: true,
        },
        2,
      ),
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
      vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.Finished, 2),
      onboardingSetupStatus: JsonExt.stringify(OnboardingSetupStatus.Checklist, 2),
      hasMiningBids: 'true',
      hasMiningSeats: 'true',
    }),
  );
  expect(fetchMiningSeats).not.toHaveBeenCalled();
  expect(importMocks.findMiningActivity).not.toHaveBeenCalled();
  expect(restart).toHaveBeenCalledOnce();
});

it.each([
  {
    activityKind: 'bid',
    activityMask: AccountActivityKind.MiningBid,
    hasMiningSeats: 'false',
  },
  {
    activityKind: 'seat',
    activityMask: AccountActivityKind.MiningSeat,
    hasMiningSeats: 'true',
  },
])('restores indexed mining $activityKind history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({
    blocks: [{ blockNumber: 10, activityMask: params.activityMask }],
    coverage: { gaps: [] },
  });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.miningBotAddress, {
    activityMask: AccountActivityKind.MiningBid | AccountActivityKind.MiningSeat,
  });
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
      hasMiningBids: 'true',
      hasMiningSeats: params.hasMiningSeats,
    }),
  );
  expect(config.certificationDetails?.dismissedWelcomeToOperationsOverlay).toBe(false);
});

it.each([
  {
    accountKind: 'legacy mining hold',
    balanceIndex: 0,
  },
  {
    accountKind: 'mining bot',
    balanceIndex: 1,
  },
])('keeps a funded $accountKind account on the checklist without bid or seat history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const balances = [emptyBalance, emptyBalance, emptyBalance, emptyBalance];
  balances[params.balanceIndex] = { ...emptyBalance, availableMicrogons: 1n };
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue(balances);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Checklist, 2),
      hasMiningBids: 'false',
      hasMiningSeats: 'false',
    }),
  );
});

it('does not invent extensions from an imported basic wallet balance', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.None, 2),
    }),
  );
});

it.each([
  { name: 'does not restore Crosschain Transfers from council signer registration alone', isActive: false },
  { name: 'restores Crosschain Transfers for an active council member', isActive: true },
])('$name', async ({ isActive }) => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: vi.fn().mockResolvedValue('0xsigner'),
        activeGlobalIssuanceCouncilByDestinationChain: vi.fn().mockResolvedValue('0xactive'),
        globalIssuanceCouncilByHash: vi.fn().mockResolvedValue({
          epochMicrogonsPerArgonot: 0n,
          members: {
            '0xsigner': {
              accountId: isActive ? importWalletKeys.vaultingAddress : '5AnotherCouncilMember',
              signer: '0xsigner',
              weight: 1n,
            },
          },
          totalWeight: 1n,
        }),
      },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: `${isActive}`,
      hasExtensionTreasury: `${isActive}`,
      hasExtensionOperations: `${isActive}`,
      hasActivatedCrosschain: `${isActive}`,
    }),
  );
});

it('preserves Operations history without granting Crosschain access from an owned minting authority', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: vi.fn().mockResolvedValue(null),
        activeGlobalIssuanceCouncilByDestinationChain: vi.fn().mockResolvedValue(null),
        mintingAuthoritiesBySigner: {
          multi: vi.fn(async (signers: string[]) =>
            signers.map((_, index) =>
              index === 0
                ? {
                    accountId: importWalletKeys.vaultingAddress,
                    destinationChain: { type: 'Ethereum' },
                  }
                : null,
            ),
          ),
        },
      },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      hasActivatedCrosschain: 'false',
    }),
  );
});

it('does not infer treasury from an unattributed account hold', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, reservedMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
    }),
  );
});

it.each([
  {
    activityKind: 'bitcoin',
    activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.VaultPosition,
    hasExtensionOperations: 'false',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.None, 2),
  },
  {
    activityKind: 'bond',
    activityMask: AccountActivityKind.BondPosition,
    hasExtensionOperations: 'false',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.None, 2),
  },
  {
    activityKind: 'vault',
    activityMask: AccountActivityKind.VaultPosition,
    hasExtensionOperations: 'true',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.Finished, 2),
  },
])('restores extensions from imported $activityKind history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.getOperatorVaultId.mockResolvedValue(params.activityKind === 'vault' ? 7 : null);
  const getVault = vi.spyOn(Vault, 'get').mockResolvedValue({ vaultId: 7 } as Vault);
  importMocks.findMiningActivity.mockImplementation(async (_address, filters) => {
    return {
      blocks:
        filters.activityMask & params.activityMask ? [{ blockNumber: 10, activityMask: params.activityMask }] : [],
      coverage: { gaps: [] },
    };
  });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.defaultArgonAddress, {
    activityMask: AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
  });
  expect(importMocks.getOperatorVaultId).toHaveBeenCalledWith(importWalletKeys.vaultingAddress);
  expect(getVault).toHaveBeenCalledTimes(params.activityKind === 'vault' ? 1 : 0);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: params.hasExtensionOperations,
      vaultingSetupStatus: params.vaultingSetupStatus,
    }),
  );

  getVault.mockRestore();
});

it('keeps proven account state when index history is unavailable during repair', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockRejectedValue(new Error('index unavailable'));
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockRejectedValue(new Error('seat lookup unavailable'));
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      hasMiningBids: 'false',
      hasMiningSeats: 'false',
    }),
  );
  expect(restart).toHaveBeenCalledOnce();

  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
    emptyBalance,
  ]);
  importMocks.getOperatorVaultId.mockRejectedValueOnce(new Error('vault lookup unavailable'));

  await new Importer(config, walletKeys, dbPromise).recoverCurrentAccountState();

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
    }),
  );
});

it('non-destructively recovers the current wallet setup', async () => {
  const db = await createTestDb();
  await db.configTable.insertOrReplace({
    walletAccountsHadPreviousLife: 'false',
    hasExtensionTreasury: 'false',
    hasExtensionOperations: 'false',
    certificationDetails: JsonExt.stringify({ hasSavedMnemonic: false }, 2),
    walletPreviousLifeRecovered: 'false',
    userJurisdiction: JsonExt.stringify(testJurisdiction, 2),
  });
  const dbPromise = Promise.resolve(db);
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});

  await new Importer(config, walletKeys, dbPromise).recoverCurrentAccountState();

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.walletPreviousLifeRecovered).toBe(false);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.certificationDetails?.hasSavedMnemonic).toBe(false);

  instanceChecks.delete(Config.prototype.constructor);
  const recoverAccount = vi.fn(async () => ({}));
  const restartedConfig = new Config(dbPromise);
  const restartedStartup = new AppStartup(restartedConfig, walletKeys, startupClients);
  await restartedStartup.initialize();
  await restartedStartup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery);

  expect(recoverAccount).toHaveBeenCalledOnce();
  expect(restartedConfig.walletAccountsHadPreviousLife).toBe(true);
  expect(restartedConfig.walletPreviousLifeRecovered).toBe(true);
  expect(restartedStartup.isRecoveringHistory).toBe(false);
  expect(restartedConfig.hasExtensionTreasury).toBe(true);
  expect(restartedConfig.hasExtensionOperations).toBe(true);
  expect(restartedConfig.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(restartedConfig.certificationDetails?.hasSavedMnemonic).toBe(false);
});

it('inspects a readonly account using only its available public addresses', async () => {
  const { walletKeys } = createTestWallet('//Alice', { canSign: false, canAccessServer: false });
  walletKeys.legacyMiningHoldAddress = '';
  const { config, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockImplementation(async (_api, addresses: string[]) => {
    if (addresses.some(address => !address)) throw new Error('Cannot query an empty account address');
    return addresses.map(address =>
      address === walletKeys.miningBotAddress ? { ...emptyBalance, availableMicrogons: 1n } : emptyBalance,
    );
  });
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});

  await new Importer(config, walletKeys, dbPromise).recoverCurrentAccountState();

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
});

it('restores a matching server without completing mining setup when bidding rules are absent', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: 'http://beacon',
    ethereumExecutionRpcUrl: 'http://execution',
  });

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  const importer = new Importer(config, walletKeys, dbPromise);
  await importer.importFromServer('10.0.0.1');

  expect(config.isServerInstalled).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      isServerInstalled: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Checklist, 2),
    }),
  );
  expect(saveSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({
      biddingRules: expect.anything(),
    }),
  );
});

it('restores completed mining setup from a matching server with bidding rules', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: Config.getDefault('biddingRules') as IConfig['biddingRules'],
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: 'http://beacon',
    ethereumExecutionRpcUrl: 'http://execution',
    hasMiningBids: false,
    hasMiningSeats: false,
  });

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.serverDetails.ipAddress).toBe('10.0.0.1');
  expect(config.isServerInstalled).toBe(true);
  expect(config.isServerInstalling).toBe(false);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(false);
  expect(config.hasMiningSeats).toBe(false);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      biddingRules: JsonExt.stringify(Config.getDefault('biddingRules'), 2),
      isServerInstalled: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
    }),
  );
});

it('restores completed mining setup from server bid history without bidding rules', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: undefined,
    ethereumExecutionRpcUrl: undefined,
    hasMiningBids: true,
    hasMiningSeats: false,
  });

  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(false);
});

it('does not erase stronger imported mining history when server flags are false', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
    hasMiningBids: 'true',
    hasMiningSeats: 'false',
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: undefined,
    ethereumExecutionRpcUrl: undefined,
    hasMiningBids: false,
    hasMiningSeats: false,
  });

  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(false);
});

const emptyBalance = {
  availableMicrogons: 0n,
  reservedMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicronots: 0n,
};
