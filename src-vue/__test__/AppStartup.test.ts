import './helpers/mocks.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reactive, watchEffect, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { AppStartup } from '../lib/AppStartup.ts';
import type { WalletRecovery } from '../lib/WalletRecovery.ts';
import { AccountSecurity } from '../lib/AccountSecurity.ts';
import type { ArgonClient, MainchainClients } from '@argonprotocol/apps-core';
import { Config } from '../lib/Config.ts';
import { createMockedDbPromise, createTestDb } from './helpers/db.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { bitcoinLockHdPath, WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { EncryptionSecret, type KeyProtection } from '../lib/EncryptionSecret.ts';
import { WalletRecoveryError, WalletSecrets } from '../lib/WalletSecrets.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { MiningSetupStatus, ServerType, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import {
  JsonExt,
  Vault,
  encryptBootstrapRecovery,
  encryptBootstrapEndpoint,
  miniSecretFromUri,
  createDeferred,
} from '@argonprotocol/apps-core';
import { getOfflineRegistry, hexToU8a, Keyring, u8aToHex, type ArgonPrimitivesVault } from '@argonprotocol/mainchain';
import { toPlain } from '@argonprotocol/runtime-client';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { signatureVerify } from '@polkadot/util-crypto';
import { LocalMachine } from '../lib/LocalMachine.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { getUserJurisdiction } from '../lib/Countries.ts';
import { writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { getAppStartup, useStartupStore, getBot, getInstaller } from '../stores/startup.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getConfig } from '../stores/config.ts';
import { SSH } from '../lib/SSH.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';
import basicEmitter, { type IAccountAuthenticationRequest } from '../emitters/basicEmitter.ts';

const readAccounts = vi.fn(async (addresses: string[]) => addresses.map(() => ({ data: { free: 0n, reserved: 0n } })));
const readOwnership = vi.fn(async (addresses: string[]) => addresses.map(() => ({ free: 0n, reserved: 0n })));
const readOperational = vi.fn(async () => null);
const startupClient = {
  query: {
    system: { account: { multi: readAccounts } },
    ownership: { account: { multi: readOwnership } },
    operationalAccounts: { operationalAccounts: readOperational },
  },
} as unknown as ArgonClient;
const getStartupClient = vi.fn(async () => startupClient);
const startupClients = { get: getStartupClient } as unknown as MainchainClients;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', class {});
  readAccounts
    .mockReset()
    .mockImplementation(async addresses => addresses.map(() => ({ data: { free: 0n, reserved: 0n } })));
  readOwnership.mockReset().mockImplementation(async addresses => addresses.map(() => ({ free: 0n, reserved: 0n })));
  readOperational.mockReset().mockResolvedValue(null);
  getStartupClient.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

async function loadWallet(security = new AccountSecurity()) {
  const db = await createTestDb();
  try {
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    return (await WalletKeys.load({ db, config }, security)).walletKeys;
  } finally {
    await db.close();
  }
}

const startupMnemonic = 'test test test test test test test test test test test junk';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => invokeWithTimeout(command, args, 60e3),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => undefined }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppConfig: 13 },
  readTextFile: async () => '[]',
}));

vi.mock('../../core/src/MainchainRpcProvider.js', () => ({
  getMainchainClient: () => new Promise(() => undefined),
}));

function installWalletPrimitives(directory: string) {
  const keychain: {
    key?: Buffer;
    locked: boolean;
    protection?: KeyProtection;
    wrappingKey?: Buffer;
    failCommit?: boolean;
    failCreate?: boolean;
    failCommitAfterCreate?: boolean;
    failCleanup?: boolean;
  } = {
    locked: false,
  };
  const encryptionKey = (authentication?: { wrappingKey?: number[] }) => {
    if (keychain.locked) throw new Error('Keychain access denied');
    if (!keychain.key) throw new Error('Wallet encryption key is unavailable');
    if (keychain.wrappingKey && !keychain.wrappingKey.equals(Buffer.from(authentication?.wrappingKey ?? []))) {
      throw new Error('Passcode did not unlock the encryption key');
    }
    return keychain.key;
  };
  const read = async (name: string) => {
    try {
      return await fs.readFile(path.join(directory, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  vi.mocked(invokeWithTimeout).mockImplementation(async (command, args) => {
    if (command === 'read_wallet_file') return read(args.filename);
    if (command === 'delete_wallet_file') return fs.rm(path.join(directory, args.filename), { force: true });
    if (command === 'read_mnemonic_file') return read('mnemonic');
    if (command === 'system_authentication_option') return null;
    if (command === 'keychain_info') {
      if (keychain.locked) throw new Error('Keychain access denied');
      return keychain.key ? (keychain.protection ?? { method: 'none' }) : null;
    }
    if (command === 'keychain_create') {
      if (keychain.locked) throw new Error('Keychain access denied');
      if (keychain.failCreate) throw new Error('Keychain write failed');
      if (keychain.key && !args.replaceExisting) throw new Error('This profile already has an encryption key');
      keychain.key = Buffer.from(args.key);
      keychain.protection = args.protection;
      if (args.protection.method === 'passcode') keychain.wrappingKey = Buffer.from(args.authentication.wrappingKey);
      else delete keychain.wrappingKey;
      if (keychain.failCommitAfterCreate) keychain.failCommit = true;
      return;
    }
    if (command === 'keychain_authenticate') {
      encryptionKey(args.authentication);
      return;
    }
    if (command === 'keychain_set_protection') {
      encryptionKey(args.authentication);
      keychain.protection = args.protection;
      if (args.protection.method === 'passcode') keychain.wrappingKey = Buffer.from(args.newAuthentication.wrappingKey);
      else delete keychain.wrappingKey;
      return;
    }
    if (command === 'keychain_encrypt') {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey(args.authentication), nonce);
      return Buffer.concat([nonce, cipher.update(args.plaintext), cipher.final(), cipher.getAuthTag()]).toString(
        'base64',
      );
    }
    if (command === 'keychain_decrypt') {
      const key = encryptionKey(args.authentication);
      return (args.ciphertexts as string[]).map((ciphertext, index) => {
        try {
          const contents = Buffer.from(ciphertext, 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(0, 12));
          decipher.setAuthTag(contents.subarray(-16));
          return Buffer.concat([decipher.update(contents.subarray(12, -16)), decipher.final()]).toString();
        } catch (error) {
          if (index < (args.requiredCount ?? args.ciphertexts.length)) throw error;
          return null;
        }
      });
    }
    if (command === 'cleanup_mnemonic_files') {
      if (keychain.failCleanup) throw new Error('Synthetic mnemonic cleanup failed');
      return;
    }
    if (command === 'write_wallet_file') {
      const temporary = path.join(directory, `${args.filename}.tmp`);
      const pendingContents = await read(`${args.filename}.tmp`);
      if (args.createNew && pendingContents !== null) {
        if (pendingContents !== args.contents) throw new Error('A different pending wallet exists');
      } else {
        if (!args.createNew) await fs.rm(temporary, { force: true });
        const file = await fs.open(temporary, 'wx');
        try {
          await file.writeFile(args.contents);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      if (keychain.failCommit) throw new Error('Commit failed');
      const destination = path.join(directory, args.filename);
      if (args.createNew) {
        await fs.link(temporary, destination);
        await fs.unlink(temporary);
      } else {
        await fs.rename(temporary, destination);
      }
      return;
    }
    throw new Error(`Unexpected wallet primitive: ${command}`);
  });
  return keychain;
}

it.each(['none', 'wallet write', 'database write'] as const)(
  'protects a released random-key wallet without losing saved secrets (interrupted save: %s)',
  async interrupted => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-protection-'));
    const db = await createTestDb();
    const keychain = installWalletPrimitives(directory);
    try {
      keychain.key = Buffer.alloc(32, 0x37);
      const saved = await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
      const secret = new EncryptionSecret();
      const privateKey = `0x${'42'.repeat(32)}` as const;
      const imported = await db.walletsTable.importExternalEthereum({
        address: privateKeyToAccount(privateKey).address,
        coreEthereumAddress: saved.identity.ethereumAddress,
        secretKind: 'privateKey',
        encryptedSecret: await secret.encrypt(privateKey),
      });
      await db.configTable.insertOrReplace({
        serverAdd: JsonExt.stringify({
          digitalOcean: { encryptedApiKey: await secret.encrypt('synthetic service token') },
        }),
      });
      instanceChecks.delete(Config.prototype.constructor);
      const config = new Config(Promise.resolve(db));
      await config.load();
      const security = new AccountSecurity(prompt => prompt.verify('replacement protection passphrase'));
      const keys = new WalletKeys(saved.identity, new WalletSecrets(saved.wallet, security));
      const ethereumWallets = new WalletsForEthereum(
        keys,
        Promise.resolve(db),
        Promise.resolve(db.financialCacheTable),
        security.request.bind(security),
      );
      await ethereumWallets.reloadRecords();
      const loadedWallet = ethereumWallets.get(imported.id);
      loadedWallet.data.availableMicrogons = 5n;
      const passcode = 'synthetic protection passphrase';
      const originalFile = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
      vi.mocked(invokeWithTimeout).mockClear();
      await expect(
        security.configure(
          { method: 'passcode', newPasscode: passcode },
          { walletKeys: keys, db, config, ethereumWallets },
        ),
      ).rejects.toThrow('Back up your mnemonic');
      expect(vi.mocked(invokeWithTimeout).mock.calls.some(([command]) => command === 'cleanup_mnemonic_files')).toBe(
        false,
      );
      config.setCertificationDetails({ hasSavedMnemonic: true });
      keychain.failCleanup = true;
      await expect(
        security.configure(
          { method: 'passcode', newPasscode: passcode },
          { walletKeys: keys, db, config, ethereumWallets },
        ),
      ).rejects.toThrow('Could not remove old mnemonic files');
      expect(keychain.protection?.method ?? 'none').toBe('none');
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(originalFile);
      expect(await secret.decrypt([saved.wallet.encryptedMnemonic])).toEqual([startupMnemonic]);
      keychain.failCleanup = false;
      vi.mocked(invokeWithTimeout).mockClear();

      if (interrupted === 'database write') {
        vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('Synthetic database interruption'));
        await expect(
          security.configure(
            { method: 'passcode', newPasscode: passcode },
            { walletKeys: keys, db, config, ethereumWallets },
          ),
        ).rejects.toThrow('Synthetic database interruption');
        expect(keychain.protection?.method).toBe('passcode');
        expect((await db.walletsTable.fetchEthereumWallets())[0].encryptedSecret).toBe(imported.encryptedSecret);
        const restarted = await WalletKeys.load({ db, config }, new AccountSecurity(prompt => prompt.verify(passcode)));
        const wallet = new WalletForEthereum(imported.address, undefined, imported);
        const signature = await (
          await restarted.walletKeys.getEthereumSigner(undefined, wallet)
        ).signMessage({ message: 'restarted account' });
        expect((await recoverMessageAddress({ message: 'restarted account', signature })).toLowerCase()).toBe(
          imported.address,
        );
        await ethereumWallets.reloadRecords();
      } else if (interrupted === 'wallet write') {
        keychain.failCommitAfterCreate = true;
        await security.configure(
          { method: 'passcode', newPasscode: passcode },
          { walletKeys: keys, db, config, ethereumWallets },
        );
        expect(keychain.protection?.method).toBe('passcode');
        expect(security.data.method).toBe('passcode');
        expect(security.data.isLoaded).toBe(true);
        expect(
          JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).pendingKeyChange,
        ).toBeDefined();
        await expect(
          security.configure(
            { method: 'none', currentPasscode: passcode },
            { walletKeys: keys, db, config, ethereumWallets },
          ),
        ).rejects.toThrow('Commit failed');
        expect(keychain.protection?.method).toBe('passcode');
        keychain.failCommitAfterCreate = false;
        keychain.failCommit = false;
        const restarted = await WalletKeys.load({ db, config }, new AccountSecurity(prompt => prompt.verify(passcode)));
        expect(restarted.walletKeys.canSign).toBe(true);
        expect(restarted.didChangeEncryptionKey).toBe(true);
      } else {
        await security.configure(
          { method: 'passcode', newPasscode: passcode },
          { walletKeys: keys, db, config, ethereumWallets },
        );
      }

      expect(keychain.key).toEqual(Buffer.from(hexToU8a(miniSecretFromUri(`${startupMnemonic}//wallet-encryption`))));
      const protectedWallet = JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8'));
      expect(protectedWallet.meta).toEqual(saved.identity);
      expect(protectedWallet.pendingKeyChange).toBeUndefined();
      expect(invokeWithTimeout).toHaveBeenCalledWith('cleanup_mnemonic_files', { mnemonic: startupMnemonic }, 30e3);
      const [persisted] = await db.walletsTable.fetchEthereumWallets();
      expect(persisted.id).toBe(imported.id);
      expect(ethereumWallets.get(imported.id)).toBe(loadedWallet);
      expect(loadedWallet.record?.encryptedSecret).toBe(persisted.encryptedSecret);
      expect(loadedWallet.record?.encryptedSecret).not.toBe(imported.encryptedSecret);
      expect(loadedWallet.data.availableMicrogons).toBe(5n);
      const service = config.serverAdd!.digitalOcean!.encryptedApiKey!;
      expect(await secret.decrypt([persisted.encryptedSecret!, service], { passcode })).toEqual([
        privateKey,
        'synthetic service token',
      ]);
      const committedFile = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
      await expect(
        security.configure(
          { method: 'none', currentPasscode: 'wrong passcode' },
          { walletKeys: keys, db, config, ethereumWallets },
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(committedFile);
      expect(loadedWallet.record?.encryptedSecret).toBe(persisted.encryptedSecret);
      delete keychain.key;
      await expect(WalletKeys.load({ db, config }, new AccountSecurity())).rejects.toThrow('could not unlock');
      const replacement = 'replacement protection passphrase';
      await AccountSecurity.recoverWithNewPasscode({ mnemonic: startupMnemonic, newPasscode: replacement, db, config });
      expect(await secret.decrypt([persisted.encryptedSecret!, service], { passcode: replacement })).toEqual([
        privateKey,
        'synthetic service token',
      ]);
      expect(await keys.exposeMasterMnemonic()).toBe(startupMnemonic);
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['none', 'passcode'] as const)(
  'keeps the main account and healthy imported wallets usable when other imported secrets fail (%s)',
  async method => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-startup-imported-secrets-'));
    const db = await createTestDb();
    const keychain = installWalletPrimitives(directory);
    try {
      keychain.key = Buffer.alloc(32, 0x38);
      const saved = await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
      const encryption = new EncryptionSecret();
      const privateKeys = [0x42, 0x43, 0x44, 0x45].map(byte => `0x${byte.toString(16).repeat(32)}` as const);
      // Released mnemonic-bridge recovery could replace the master key without updating imported ciphertext.
      const [orphanedSecret] = await EncryptionSecret.encryptWithKey(Buffer.alloc(32, 0x37), [privateKeys[0]]);
      const orphaned = await db.walletsTable.importExternalEthereum({
        address: privateKeyToAccount(privateKeys[0]).address,
        coreEthereumAddress: saved.identity.ethereumAddress,
        secretKind: 'privateKey',
        encryptedSecret: orphanedSecret,
      });
      const healthy = await db.walletsTable.importExternalEthereum({
        address: privateKeyToAccount(privateKeys[1]).address,
        coreEthereumAddress: saved.identity.ethereumAddress,
        secretKind: 'privateKey',
        encryptedSecret: await encryption.encrypt(privateKeys[1]),
      });
      const mismatched = await db.walletsTable.importExternalEthereum({
        address: privateKeyToAccount(privateKeys[2]).address,
        coreEthereumAddress: saved.identity.ethereumAddress,
        secretKind: 'privateKey',
        encryptedSecret: await encryption.encrypt(privateKeys[3]),
      });
      const passcode = 'synthetic startup passcode';
      if (method === 'passcode') await encryption.setProtection(method, { newPasscode: passcode });
      const originalKey = Buffer.from(keychain.key);
      const originalFile = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
      const originalRecords = await db.walletsTable.fetchEthereumWallets();
      instanceChecks.delete(Config.prototype.constructor);
      const config = new Config(Promise.resolve(db));
      await config.load();
      const security = new AccountSecurity(prompt => prompt.verify(passcode));

      const { walletKeys } = await WalletKeys.load({ db, config }, security);
      expect(walletKeys.canSign).toBe(true);
      const message = new TextEncoder().encode('synthetic main account challenge');
      const signer = await walletKeys.getDefaultArgonSigner();
      expect(signatureVerify(message, signer.sign(message), saved.identity.vaultingAddress).isValid).toBe(true);
      expect(await walletKeys.exposeMasterMnemonic()).toBe(startupMnemonic);
      const healthySigner = await walletKeys.getEthereumSigner(
        undefined,
        new WalletForEthereum(healthy.address, undefined, healthy),
      );
      const signature = await healthySigner.signMessage({ message: 'synthetic imported wallet challenge' });
      expect(
        (await recoverMessageAddress({ message: 'synthetic imported wallet challenge', signature })).toLowerCase(),
      ).toBe(healthy.address);
      for (const record of [orphaned, mismatched]) {
        await expect(
          walletKeys.getEthereumSigner(undefined, new WalletForEthereum(record.address, undefined, record)),
        ).rejects.toThrow('Reconnect it');
      }
      expect(await db.walletsTable.fetchEthereumWallets()).toEqual(originalRecords);
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(originalFile);
      expect(keychain.key).toEqual(originalKey);

      if (method === 'none') {
        config.setCertificationDetails({ hasSavedMnemonic: true });
        await expect(
          security.configure({ method: 'passcode', newPasscode: passcode }, { walletKeys, db, config }),
        ).rejects.toThrow();
        expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(originalFile);
        expect(keychain.key).toEqual(originalKey);
        expect(await db.walletsTable.fetchEthereumWallets()).toEqual(originalRecords);
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it('recovers a protected derived-key account after an interrupted save without the old passcode', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-passcode-recovery-'));
  const keychain = installWalletPrimitives(directory);
  const db = await createTestDb();
  try {
    const saved = await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    const originalKey = Buffer.from(keychain.key!);
    const encryption = new EncryptionSecret();
    const imported = await encryption.encrypt('synthetic imported private key');
    await encryption.setProtection('passcode', { newPasscode: 'original synthetic passcode' });
    const originalFile = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    const options: Parameters<typeof AccountSecurity.recoverWithNewPasscode>[0] = {
      mnemonic: startupMnemonic,
      newPasscode: 'replacement synthetic passcode',
      db,
      config,
    };

    await expect(
      AccountSecurity.recoverWithNewPasscode({ ...options, mnemonic: 'abandon '.repeat(11) + 'about' }),
    ).rejects.toThrow('does not match');
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(originalFile);
    expect(keychain.key).toEqual(originalKey);

    // Fail after keychain protection commits, before the wallet's atomic rename.
    keychain.failCommit = true;
    await expect(AccountSecurity.recoverWithNewPasscode(options)).rejects.toThrow('could not finish');
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(originalFile);
    const committedKey = Buffer.from(keychain.key!);
    keychain.failCommit = false;
    await AccountSecurity.recoverWithNewPasscode(options);
    expect(keychain.key).toEqual(committedKey);
    const restored = JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8'));
    expect(restored.meta).toEqual(saved.wallet.meta);
    expect(await encryption.decrypt([restored.encryptedMnemonic], { passcode: options.newPasscode })).toEqual([
      startupMnemonic,
    ]);
    expect(keychain.key).toEqual(originalKey);
    expect(await encryption.decrypt([imported], { passcode: options.newPasscode })).toEqual([
      'synthetic imported private key',
    ]);
    const loaded = await loadWallet(new AccountSecurity(prompt => prompt.verify(options.newPasscode)));
    expect(loaded.canSign).toBe(true);
    expect(loaded.vaultingAddress).toBe(saved.identity.vaultingAddress);
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('rebuilds a canceled key-change snapshot before mnemonic recovery so later saved secrets survive', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-canceled-protection-'));
  const db = await createTestDb();
  const keychain = installWalletPrimitives(directory);
  try {
    keychain.key = Buffer.alloc(32, 0x37);
    const originalKey = Buffer.from(keychain.key);
    const saved = await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    const secret = new EncryptionSecret();
    const keys = new WalletKeys(saved.identity, new WalletSecrets(saved.wallet));
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    keychain.failCreate = true;
    config.setCertificationDetails({ hasSavedMnemonic: true });
    await expect(
      new AccountSecurity().configure(
        { method: 'passcode', newPasscode: 'synthetic protected account' },
        { walletKeys: keys, db, config },
      ),
    ).rejects.toThrow('Keychain write failed');
    expect(keychain.key).toEqual(originalKey);
    expect(keychain.protection?.method ?? 'none').toBe('none');

    const privateKey = `0x${'43'.repeat(32)}` as const;
    await db.walletsTable.importExternalEthereum({
      address: privateKeyToAccount(privateKey).address,
      coreEthereumAddress: saved.identity.ethereumAddress,
      secretKind: 'privateKey',
      encryptedSecret: await secret.encrypt(privateKey),
    });
    keychain.failCreate = false;
    const passcode = 'replacement protected account';
    await AccountSecurity.recoverWithNewPasscode({ mnemonic: startupMnemonic, newPasscode: passcode, db, config });
    const [imported] = await db.walletsTable.fetchEthereumWallets();
    expect(await secret.decrypt([imported.encryptedSecret!], { passcode })).toEqual([privateKey]);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).pendingKeyChange).toBeUndefined();
    const restarted = await WalletKeys.load({ db, config }, new AccountSecurity(prompt => prompt.verify(passcode)));
    expect(restarted.walletKeys.canSign).toBe(true);
    expect(restarted.walletKeys.vaultingAddress).toBe(saved.identity.vaultingAddress);
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('opens session keys at startup, protects secret exports, and requires approval again after restart', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-protected-startup-'));
  const keychain = installWalletPrimitives(directory);
  const db = await createTestDb();
  setDbPromise(Promise.resolve(db));
  let request: IAccountAuthenticationRequest | undefined;
  const receivePrompt = (next: IAccountAuthenticationRequest) => {
    request = next;
  };
  basicEmitter.on('requestAccountAuthentication', receivePrompt);
  try {
    await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    const referenceKeys = WalletKeys.fromMnemonic(startupMnemonic);
    await db.walletHdKeysTable.upsert({
      keyRole: 'bitcoinLock',
      scopeKey: '7',
      hdIndex: 17,
      hdPath: bitcoinLockHdPath(7, 17),
      address: 'synthetic-allocation',
    });
    await db.walletHdKeysTable.upsert({
      keyRole: 'mintingAuthority',
      scopeKey: referenceKeys.vaultingAddress.toLowerCase(),
      hdIndex: 160,
      hdPath: referenceKeys.getMintingAuthorityEthereumHdPath(160),
      address: 'synthetic-authority',
    });
    const walletBefore = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    const passcode = 'Synthetic startup passphrase';
    const parameters = { N: 131072, r: 8, p: 1, dkLen: 32 } as const;
    const salt = '01010101010101010101010101010101';
    keychain.protection = { method: 'passcode', kdf: { algorithm: 'scrypt', parameters, salt } };
    keychain.wrappingKey = scryptSync(passcode, Buffer.from(salt, 'hex'), 32, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: 256 * 1024 * 1024,
    });

    await db.configTable.insertOrReplace({
      walletAccountsHadPreviousLife: 'false',
      showWelcomeOverlay: 'false',
      postWelcomeLaunchCount: '2',
      userJurisdiction: JsonExt.stringify({
        ...(Config.getDefault('userJurisdiction') as Config['userJurisdiction']),
        countryCode: 'US',
      }),
    });
    Object.assign(SSH, { setConfig: vi.fn() });
    const coordinator = useStartupStore();
    await expect(coordinator.initialize({ passcode: 'wrong passphrase' })).rejects.toThrow(
      'Could not unlock your account. Check your app passcode and try again.',
    );
    expect(coordinator.errorMessage).toBe('Could not unlock your account. Check your app passcode and try again.');
    expect(coordinator.isWalletReady).toBe(false);
    const canceled = coordinator.initialize();
    const canceledResult = expect(canceled).rejects.toThrow('Canceled by user');
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(() => getWalletKeys()).toThrow('Wallet startup has not finished');
    request!.reject(new Error('Canceled by user'));
    await canceledResult;
    expect(() => getWalletKeys()).toThrow('Wallet startup has not finished');

    request = undefined;
    const recoveryApproval = { passcode };
    await coordinator.initialize(recoveryApproval);
    expect(request).toBeUndefined();
    expect(recoveryApproval).not.toHaveProperty('passcode');
    const keys = getWalletKeys();
    expect(keys.canSign).toBe(true);
    expect((await keys.getOperationalSigner()).address).toBe(keys.operationalAddress);
    expect(await keys.getSshPrivateKeySeed()).toHaveLength(32);
    request = undefined;
    for (const index of [0, 99, 117]) {
      expect(await keys.getBitcoinPublicKey(bitcoinLockHdPath(7, index), BitcoinNetwork.Regtest)).toEqual(
        await referenceKeys.getBitcoinPublicKey(bitcoinLockHdPath(7, index), BitcoinNetwork.Regtest),
      );
    }
    const authorityPaths = [
      ...keys.getMintingAuthorityEthereumHdPaths(128),
      ...[160, 288].map(index => keys.getMintingAuthorityEthereumHdPath(index)),
    ];
    expect(await keys.getEthereumAddresses(authorityPaths)).toEqual(
      await referenceKeys.getEthereumAddresses(authorityPaths),
    );
    expect(await db.walletHdKeysTable.getNextHdKeyIndex({ keyRole: 'bitcoinLock', scopeKey: '7' })).toBe(18);
    expect(
      await db.walletHdKeysTable.getNextHdKeyIndex({
        keyRole: 'mintingAuthority',
        scopeKey: referenceKeys.vaultingAddress.toLowerCase(),
      }),
    ).toBe(161);
    expect(request).toBeUndefined();
    const message = new TextEncoder().encode('session transaction');
    expect(
      signatureVerify(message, (await keys.getDefaultArgonSigner()).sign(message), keys.defaultArgonAddress).isValid,
    ).toBe(true);
    expect(request).toBeUndefined();
    for (const attempt of [() => keys.exposeMasterMnemonic()]) {
      request = undefined;
      const pending = attempt();
      const refusal = expect(pending).rejects.toThrow('Fresh approval canceled');
      await vi.waitFor(() => expect(request).toBeDefined());
      request!.reject(new Error('Fresh approval canceled'));
      await refusal;
    }
    await expect(loadWallet()).rejects.toThrow('prompt is unavailable');
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(walletBefore);

    // Mounting the app starts clients, Bot and Installer. Their readiness must share one startup.
    try {
      await coordinator.initialize();
      await getInstaller().isLoadedPromise;
      expect(getConfig().postWelcomeLaunchCount).toBe(3);
      expect((await db.configTable.fetchAllAsObject()).postWelcomeLaunchCount).toBe('3');
    } finally {
      getBot().dispose();
    }
  } finally {
    basicEmitter.off('requestAccountAuthentication', receivePrompt);
    setDbPromise(undefined);
    await db.close();
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('does not enter readonly mode when startup authentication is canceled for a protected account', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-startup-authentication-'));
  installWalletPrimitives(directory);
  const security = new AccountSecurity(async () => {
    throw new Error('Canceled by user');
  });
  try {
    await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    await new EncryptionSecret().setProtection('passcode', { newPasscode: 'Synthetic startup passphrase' });
    const saved = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    await expect(loadWallet(security)).rejects.toThrow('Canceled by user');
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(saved);
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'creates a wallet only for an empty profile or a released plaintext wallet (plaintext: %s)',
  async plaintext => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-startup-'));
    const keychain = installWalletPrimitives(directory);
    const db = await createTestDb();
    try {
      if (plaintext) await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
      instanceChecks.delete(Config.prototype.constructor);
      const config = new Config(Promise.resolve(db));
      await config.load();
      if (plaintext) {
        config.serverAdd = { digitalOcean: { apiKey: 'synthetic-service-token' } };
        await config.save();
      }
      const { walletKeys: keys } = await WalletKeys.load({ db, config }, new AccountSecurity());
      if (plaintext) {
        expect(config.digitalOceanApiKey).toBe('synthetic-service-token');
        expect((await db.configTable.fetchAllAsObject()).serverAdd).not.toContain('synthetic-service-token');
        const ciphertext = config.serverAdd!.digitalOcean!.encryptedApiKey!;
        expect(await new EncryptionSecret().decrypt([ciphertext])).toEqual(['synthetic-service-token']);
      }
      const phrase = await keys.exposeMasterMnemonic();
      if (plaintext) expect(phrase).toBe(startupMnemonic);
      expect(await keys.matchesMnemonic(phrase)).toBe(true);
      expect((await keys.getOperationalSigner()).address).toBe(keys.operationalAddress);
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).not.toContain(phrase);
      if (plaintext) expect(await fs.readFile(path.join(directory, 'mnemonic'), 'utf8')).toBe(startupMnemonic);

      const saved = JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8'));
      const identity = WalletKeys.deriveIdentity(phrase);
      expect(saved.meta).toEqual({
        miningBotAddress: identity.miningBotAddress,
        vaultingAddress: identity.vaultingAddress,
        operationalAddress: identity.operationalAddress,
        ethereumAddress: identity.ethereumAddress,
      });
      expect(keys.sshPublicKey).toMatch(/^ssh-ed25519 /);
      expect(keys.legacyMiningHoldAddress).toBe(createTestWallet(phrase).legacyMiningHoldAccount.address);
      expect(saved.protection).toBe('none');
      if (plaintext) {
        // Independent sp_core::ed25519 hard-derivation fixture for this public test mnemonic.
        expect(keychain.key!.toString('hex')).toBe('40551763b1389acb9ecabc81cbc56fba4ad450e1aeedb92db86dc4dfc2a7b166');
        // Released wallets omit protection metadata and use an already-stored, independently generated key.
        delete saved.protection;
        // The released native writer predates Ethereum address metadata as well.
        delete saved.meta.ethereumAddress;
        keychain.key = Buffer.alloc(32, 0x19);
        saved.encryptedMnemonic = await new EncryptionSecret().encrypt(phrase);
        await fs.writeFile(path.join(directory, 'wallet.json'), JSON.stringify(saved));
      }
      const savedBytes = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
      const savedKey = Buffer.from(keychain.key!);
      const restarted = await loadWallet();
      expect(restarted.defaultArgonAddress).toBe(keys.defaultArgonAddress);
      expect(restarted.coreEthereumAddress).toBe(keys.coreEthereumAddress);
      expect((await restarted.getOperationalSigner()).address).toBe(keys.operationalAddress);
      expect(restarted.sshPublicKey).toBe(keys.sshPublicKey);
      expect(restarted.legacyMiningHoldAddress).toBe(keys.legacyMiningHoldAddress);
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(savedBytes);
      expect(keychain.key).toEqual(savedKey);
    } finally {
      await db.close();
      vi.mocked(invokeWithTimeout).mockReset();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['not valid json', '{"meta":{}}'])(
  'preserves an unsupported wallet instead of rewriting or replacing it: %s',
  async contents => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-invalid-'));
    const keychain = installWalletPrimitives(directory);
    keychain.key = Buffer.alloc(32, 7);
    try {
      await fs.writeFile(path.join(directory, 'wallet.json'), contents);
      await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
      await expect(WalletSecrets.readSavedWallet()).rejects.toBeInstanceOf(WalletRecoveryError);
      await expect(loadWallet()).rejects.toThrow('Your saved account could not be read.');
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
      expect(keychain.key).toEqual(Buffer.alloc(32, 7));
    } finally {
      vi.mocked(invokeWithTimeout).mockReset();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  'loads public identity readonly and restores signing (older metadata: %s)',
  async olderMetadata => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-denied-'));
    const keychain = installWalletPrimitives(directory);
    try {
      await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
      const identity = WalletKeys.deriveIdentity(startupMnemonic);
      if (olderMetadata) {
        const wallet = JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8'));
        wallet.meta = {
          ...identity,
          sshPublicKey: 'synthetic-obsolete-ssh-key',
          miningHoldAddress: 'synthetic-obsolete-holding-address',
          ethereumHdPrefixes: {
            primary: "m/44'/60'/0'/0'",
            councilSigner: "m/44'/60'/1'/0'",
            mintingAuthority: "m/44'/60'/2'/0'",
          },
        };
        await fs.writeFile(path.join(directory, 'wallet.json'), JSON.stringify(wallet));
      }
      await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
      const contents = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
      const key = Buffer.from(keychain.key!);
      keychain.locked = true;
      const readonly = await loadWallet();
      expect(readonly.defaultArgonAddress).toBe(identity.vaultingAddress);
      expect(readonly.coreEthereumAddress).toBe(identity.ethereumAddress.toLowerCase());
      expect(readonly.sshPublicKey).toBe('');
      expect(readonly.legacyMiningHoldAddress).toBe('');
      expect(readonly.canSign).toBe(false);
      expect(readonly.canAccessServer).toBe(false);
      await expect(readonly.getDefaultArgonSigner()).rejects.toThrow('Wallet signing is unavailable');
      await expect(readonly.getSshPrivateKeySeed()).rejects.toThrow('Server access is unavailable');
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
      expect(keychain.key).toEqual(key);

      keychain.locked = false;
      const retried = await loadWallet();
      expect(retried.canSign).toBe(true);
      expect((await retried.getOperationalSigner()).address).toBe(identity.operationalAddress);
      expect(retried.sshPublicKey).toBe(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII94h+za42BaEOCyEfxtDMzYbnBUhArtQZrkTlf+LIS4',
      );
      expect(retried.legacyMiningHoldAddress).toBe(createTestWallet(startupMnemonic).legacyMiningHoldAccount.address);
      expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
    } finally {
      vi.mocked(invokeWithTimeout).mockReset();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it('preserves ciphertext and other secrets when decryption fails instead of trusting a plaintext bridge', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-recovery-'));
  const keychain = installWalletPrimitives(directory);
  try {
    await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
    const savedBytes = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    keychain.key = Buffer.alloc(32, 9);
    const secret = await new EncryptionSecret().encrypt('synthetic-imported-secret');
    const readonly = await loadWallet();
    expect(readonly.defaultArgonAddress).toBe(WalletKeys.deriveIdentity(startupMnemonic).vaultingAddress);
    expect(readonly.canSign).toBe(false);
    await expect(readonly.exposeMasterMnemonic()).rejects.toThrow('Wallet signing is unavailable');
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(savedBytes);
    expect(keychain.key).toEqual(Buffer.alloc(32, 9));
    expect(await new EncryptionSecret().decrypt([secret])).toEqual(['synthetic-imported-secret']);
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('loads the public-only wallet produced by readonly troubleshooting without creating keys', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-readonly-'));
  const keychain = installWalletPrimitives(directory);
  try {
    const address = WalletKeys.deriveIdentity(startupMnemonic).vaultingAddress;
    writeReadonlyWallet(directory, {
      operatorName: '',
      operationalAccountId: '',
      defaultAccountId: address,
      miningAccountId: '',
    });
    const contents = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    const keys = await loadWallet();
    expect(keys.defaultArgonAddress).toBe(address);
    expect(keys.miningBotAddress).toBe('');
    expect(keys.canSign).toBe(false);
    expect(keys.canAccessServer).toBe(false);
    await expect(keys.getOperationalSigner()).rejects.toThrow('Wallet signing is unavailable');
    const secretAccess = vi
      .mocked(invokeWithTimeout)
      .mock.calls.filter(([command]) =>
        ['keychain_info', 'keychain_create', 'keychain_encrypt', 'keychain_decrypt'].includes(command),
      );
    expect(secretAccess).toEqual([]);
    expect(keychain.key).toBeUndefined();
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each(['wallet.json', 'wallet.json.tmp'])(
  'does not enable signing when the decrypted mnemonic belongs to a different public wallet (%s)',
  async walletFilename => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-identity-'));
    installWalletPrimitives(directory);
    try {
      await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
      const wallet = JSON.parse(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8'));
      wallet.meta = WalletKeys.deriveIdentity(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      );
      const contents = JSON.stringify(wallet);
      if (walletFilename === 'wallet.json.tmp')
        await fs.rename(path.join(directory, 'wallet.json'), path.join(directory, walletFilename));
      await fs.writeFile(path.join(directory, walletFilename), contents);
      if (walletFilename === 'wallet.json.tmp') {
        await expect(loadWallet()).rejects.toThrow('Your saved account does not match its recovery phrase.');
        await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const keys = await loadWallet();
        expect(keys.defaultArgonAddress).toBe(wallet.meta.vaultingAddress);
        expect(keys.canSign).toBe(false);
        await expect(keys.exportEthereumPrivateKey()).rejects.toThrow('Wallet signing is unavailable');
      }
      expect(await fs.readFile(path.join(directory, walletFilename), 'utf8')).toBe(contents);
    } finally {
      vi.mocked(invokeWithTimeout).mockReset();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it('finishes the same staged wallet after a failed commit and a restart', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-staged-'));
  const keychain = installWalletPrimitives(directory);
  try {
    keychain.failCommit = true;
    await expect(
      WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true),
    ).rejects.toThrow('Commit failed');
    const contents = await fs.readFile(path.join(directory, 'wallet.json.tmp'), 'utf8');
    await expect(WalletSecrets.readSavedWallet()).resolves.toEqual(JSON.parse(contents));
    expect(contents).not.toContain(startupMnemonic);
    const identity = WalletKeys.deriveIdentity(startupMnemonic);
    expect(JSON.parse(contents).meta).toEqual({
      miningBotAddress: identity.miningBotAddress,
      vaultingAddress: identity.vaultingAddress,
      operationalAddress: identity.operationalAddress,
      ethereumAddress: identity.ethereumAddress,
    });
    const savedKey = Buffer.from(keychain.key!);
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    keychain.failCommit = false;
    keychain.locked = true;
    await expect(loadWallet()).rejects.toMatchObject({
      message: 'Your device could not unlock this account. Please try again.',
      cause: new Error('Keychain access denied'),
    });
    expect(await fs.readFile(path.join(directory, 'wallet.json.tmp'), 'utf8')).toBe(contents);
    expect(keychain.key).toEqual(savedKey);

    keychain.locked = false;
    const restarted = await loadWallet();
    expect(await restarted.exposeMasterMnemonic()).toBe(startupMnemonic);
    expect(restarted.defaultArgonAddress).toBe(WalletKeys.deriveIdentity(startupMnemonic).vaultingAddress);
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
    expect(keychain.key).toEqual(savedKey);
    await expect(fs.stat(path.join(directory, 'wallet.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('preserves a keychain-first setup when staging fails, and refuses a replacement account on restart', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-stage-failure-'));
  const keychain = installWalletPrimitives(directory);
  const invoke = vi.mocked(invokeWithTimeout).getMockImplementation()!;
  try {
    vi.mocked(invokeWithTimeout).mockImplementation(async (command, args, timeout) => {
      if (command === 'write_wallet_file') throw new Error('Synthetic staging failure');
      return invoke(command, args, timeout);
    });
    await expect(
      WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true),
    ).rejects.toThrow('Synthetic staging failure');
    const savedKey = Buffer.from(keychain.key!);
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(directory, 'wallet.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });

    vi.mocked(invokeWithTimeout).mockImplementation(invoke);
    await expect(loadWallet()).rejects.toThrow('Your saved account could not be found.');
    expect(keychain.key).toEqual(savedKey);
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('keeps the active wallet after an interrupted account import', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-import-staged-'));
  const keychain = installWalletPrimitives(directory);
  try {
    await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    const contents = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    const savedKey = Buffer.from(keychain.key!);
    keychain.failCommit = true;
    const importedMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await expect(
      WalletSecrets.saveWallet(importedMnemonic, WalletKeys.deriveIdentity(importedMnemonic)),
    ).rejects.toThrow('Commit failed');
    const staged = await fs.readFile(path.join(directory, 'wallet.json.tmp'), 'utf8');
    expect(JSON.parse(staged).meta.vaultingAddress).toBe(WalletKeys.deriveIdentity(importedMnemonic).vaultingAddress);
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);

    keychain.failCommit = false;
    const restarted = await loadWallet();
    expect(await restarted.exposeMasterMnemonic()).toBe(startupMnemonic);
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(contents);
    expect(await fs.readFile(path.join(directory, 'wallet.json.tmp'), 'utf8')).toBe(staged);
    expect(keychain.key).toEqual(savedKey);
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('rejects an invalid plaintext mnemonic before deriving identity or creating an encryption key', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-invalid-mnemonic-'));
  const keychain = installWalletPrimitives(directory);
  try {
    await fs.writeFile(path.join(directory, 'mnemonic'), 'not a recovery phrase');
    await expect(loadWallet()).rejects.toThrow('The mnemonic is invalid. No wallet file was changed.');
    expect(keychain.key).toBeUndefined();
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(directory, 'wallet.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('does not stage or activate a wallet if keychain creation fails', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-key-failure-'));
  const keychain = installWalletPrimitives(directory);
  const invoke = vi.mocked(invokeWithTimeout).getMockImplementation()!;
  try {
    vi.mocked(invokeWithTimeout).mockImplementation(async (command, args, timeout) => {
      if (command === 'keychain_create') throw new Error('Keychain write denied');
      return invoke(command, args, timeout);
    });
    await expect(
      WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true),
    ).rejects.toThrow('Keychain write denied');
    expect(keychain.key).toBeUndefined();
    await expect(fs.stat(path.join(directory, 'wallet.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('does not create a replacement when wallet.json is missing from a profile with an encryption key', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-wallet-missing-'));
  const keychain = installWalletPrimitives(directory);
  keychain.key = Buffer.alloc(32, 7);
  try {
    await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
    await expect(loadWallet()).rejects.toThrow('Your saved account could not be found.');
    expect(keychain.key).toEqual(Buffer.alloc(32, 7));
    await expect(fs.stat(path.join(directory, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])('restores a vault without replacing its creation draft (saved: %s)', async saved => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet('//Alice');
  const vault = new Vault(
    7,
    toPlain(
      getOfflineRegistry().createType<ArgonPrimitivesVault>('ArgonPrimitivesVault', {
        operatorAccountId: walletKeys.vaultingAddress,
        securitization: 9_000_000n,
      }),
    ) as ConstructorParameters<typeof Vault>[1],
    1_000,
  );
  const vaultSetup = {
    ...(Config.getDefault('vaultSetup') as Config['vaultSetup']),
    securitizationMicrogons: 4_000_000n,
    committedMicronots: 6_000_000n,
  };
  await db.configTable.insertOrReplace({
    walletAccountsHadPreviousLife: 'true',
    walletPreviousLifeRecovered: 'false',
    ...(saved ? { vaultSetup: JsonExt.stringify(vaultSetup) } : {}),
  });
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  const startup = new AppStartup(config, walletKeys, startupClients);
  await startup.initialize();

  await startup.recoverPreviousWalletHistory({ findHistory: async () => ({ vault }) } as unknown as WalletRecovery);
  expect(config.vaultingSetupStatus).toBe(VaultingSetupStatus.Finished);
  expect(config.vaultSetup).toEqual(saved ? vaultSetup : Config.getDefault('vaultSetup'));
  expect(config.hasSavedVaultSetup).toBe(saved);
  expect(config.walletPreviousLifeRecovered).toBe(true);

  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(db));
  await restarted.load();
  expect(restarted.vaultingSetupStatus).toBe(VaultingSetupStatus.Finished);
  expect(restarted.vaultSetup).toEqual(config.vaultSetup);
  expect(restarted.walletPreviousLifeRecovered).toBe(true);
  await db.close();
});

it('keeps mnemonic-restored accounts eligible for financial history without mining or vault history', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  readAccounts.mockResolvedValueOnce([{ data: { free: 1n, reserved: 0n } }]);
  const recoverAccount = vi.fn(async () => ({}));
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  const startup = new AppStartup(config, walletKeys, startupClients);

  await startup.initialize();
  await startup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery);

  expect(recoverAccount).toHaveBeenCalledOnce();
  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.walletPreviousLifeRecovered).toBe(true);
});

it('initializes wallet history from a migrated readonly database', async () => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet('//Alice', { canSign: false, canAccessServer: false });
  readAccounts.mockResolvedValueOnce([{ data: { free: 1n, reserved: 0n } }]);
  const recoverAccount = vi.fn(async () => ({}));
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  const startup = new AppStartup(config, walletKeys, startupClients);

  await startup.initialize();
  await startup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery);

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.showWelcomeOverlay).toBe(false);
  expect(config.walletPreviousLifeRecovered).toBe(true);
  expect(recoverAccount).toHaveBeenCalledOnce();

  const { walletKeys: restartedWalletKeys } = createTestWallet('//Alice', {
    canSign: false,
    canAccessServer: false,
  });
  const inspectWalletHistory = getStartupClient;
  inspectWalletHistory.mockClear();
  const recoverAfterRestart = vi.fn(async () => ({}));
  instanceChecks.delete(Config.prototype.constructor);
  const restartedConfig = new Config(Promise.resolve(db));
  const restartedStartup = new AppStartup(restartedConfig, restartedWalletKeys, startupClients);

  await restartedStartup.initialize();
  await restartedStartup.recoverPreviousWalletHistory({
    findHistory: recoverAfterRestart,
  } as unknown as WalletRecovery);

  expect(restartedConfig.walletAccountsHadPreviousLife).toBe(true);
  expect(restartedConfig.showWelcomeOverlay).toBe(false);
  expect(inspectWalletHistory).not.toHaveBeenCalled();
  expect(recoverAfterRestart).not.toHaveBeenCalled();
  await db.close();
});

it('leaves failed previous-life recovery retryable after config finishes loading', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  readAccounts.mockResolvedValueOnce([{ data: { free: 1n, reserved: 0n } }]);
  const recoverAccount = vi.fn().mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce({});
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);
  const startup = new AppStartup(config, walletKeys, startupClients);

  await startup.initialize();
  await expect(
    startup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery),
  ).rejects.toThrow('history unavailable');

  expect(config.walletPreviousLifeRecovered).toBe(false);
  expect(startup.isRecoveringHistory).toBe(false);

  await startup.recoverPreviousWalletHistory({ findHistory: recoverAccount } as unknown as WalletRecovery);

  expect(config.walletPreviousLifeRecovered).toBe(true);
  expect(recoverAccount).toHaveBeenCalledTimes(2);
});

it('reserves the final recovery progress for applying and saving config', async () => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet('//Alice');
  readAccounts.mockResolvedValueOnce([{ data: { free: 1n, reserved: 0n } }]);
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
  const config = new Config(Promise.resolve(db));
  const startup = reactive(new AppStartup(config, walletKeys, startupClients));
  let visibleProgress = 0;
  let visibleRecovery = false;
  const stop = watchEffect(() => {
    visibleProgress = startup.historyLoadPct;
    visibleRecovery = startup.isRecoveringHistory;
  });
  await startup.initialize();
  const loadPromise = startup.recoverPreviousWalletHistory({
    findHistory: recoverAccount,
  } as unknown as WalletRecovery);
  await vi.waitFor(() => expect(reportProgress).toBeTypeOf('function'));

  reportProgress?.(50);
  await nextTick();
  expect(visibleProgress).toBe(47.5);
  expect(visibleRecovery).toBe(true);
  expect(startup.isReady).toBe(true);

  finishRecovery?.({});
  await loadPromise;
  await nextTick();

  expect(visibleProgress).toBe(100);
  expect(visibleRecovery).toBe(false);
  expect((await db.configTable.fetchAllAsObject()).walletPreviousLifeRecovered).toBe('true');
  stop();
  await db.close();
});

it('retries first-launch account discovery after restarting over an incomplete setup', async () => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet('//Alice');
  readAccounts
    .mockRejectedValueOnce(new Error('account lookup unavailable'))
    .mockResolvedValueOnce([{ data: { free: 1n, reserved: 0n } }]);
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  const startup = new AppStartup(config, walletKeys, startupClients);
  void startup.isReadyPromise.catch(() => undefined);

  await expect(startup.initialize()).rejects.toThrow('account lookup unavailable');
  expect(startup.isReady).toBe(false);
  expect((await db.configTable.fetchAllAsObject()).walletAccountsHadPreviousLife).toBeUndefined();

  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(db));
  const restartedStartup = new AppStartup(restarted, walletKeys, startupClients);
  await restartedStartup.initialize();
  await restartedStartup.recoverPreviousWalletHistory({ findHistory: async () => ({}) } as unknown as WalletRecovery);

  expect(restarted.walletAccountsHadPreviousLife).toBe(true);
  expect(restarted.showWelcomeOverlay).toBe(false);
  expect((await db.configTable.fetchAllAsObject()).walletPreviousLifeRecovered).toBe('true');
  await db.close();
});

it('initializes jurisdiction after config is restored into a recreated database', async () => {
  const db = await createTestDb();
  const replacementDb = await createTestDb();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(Promise.resolve(db));
  await config.load();
  await config.restoreToConnection(replacementDb.sql);

  const location = {
    ...(Config.getDefault('userJurisdiction') as Config['userJurisdiction']),
    countryCode: 'US',
    latitude: '35',
    longitude: '-85',
  };
  vi.mocked(getUserJurisdiction).mockResolvedValueOnce(location);
  instanceChecks.delete(Config.prototype.constructor);
  const restarted = new Config(Promise.resolve(replacementDb));
  const { walletKeys } = createTestWallet('//Alice');
  await new AppStartup(restarted, walletKeys, startupClients).initialize();

  expect(restarted.userJurisdiction).toEqual(location);
  expect(JsonExt.parse((await replacementDb.configTable.fetchAllAsObject()).userJurisdiction!)).toEqual(location);
  await db.close();
  await replacementDb.close();
});

it.each([false, true])('preserves local mnemonic recovery files during startup (copy marker: %s)', async saved => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'argon-startup-cleanup-'));
  const db = await createTestDb();
  installWalletPrimitives(directory);
  try {
    await WalletSecrets.saveWallet(startupMnemonic, WalletKeys.deriveIdentity(startupMnemonic), true);
    const walletBefore = await fs.readFile(path.join(directory, 'wallet.json'), 'utf8');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    await config.load();
    config.setCertificationDetails({ hasSavedMnemonic: saved });
    await config.save();
    await fs.writeFile(path.join(directory, 'mnemonic'), startupMnemonic);
    vi.mocked(invokeWithTimeout).mockClear();

    const loaded = await WalletKeys.load({ db, config }, new AccountSecurity());

    expect(loaded.walletKeys.canSign).toBe(true);
    const cleanupCalls = vi
      .mocked(invokeWithTimeout)
      .mock.calls.filter(([command]) => command === 'cleanup_mnemonic_files');
    expect(cleanupCalls).toEqual([]);
    expect(await fs.readFile(path.join(directory, 'mnemonic'), 'utf8')).toBe(startupMnemonic);
    expect(await fs.readFile(path.join(directory, 'wallet.json'), 'utf8')).toBe(walletBefore);
    expect(vi.mocked(invokeWithTimeout).mock.calls.filter(([command]) => command === 'keychain_decrypt')).toHaveLength(
      1,
    );
  } finally {
    await db.close();
    vi.mocked(invokeWithTimeout).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'counts launches only after welcome has been dismissed (welcome: %s)',
  async showWelcomeOverlay => {
    const db = await createTestDb();
    await db.configTable.insertOrReplace({
      showWelcomeOverlay: JsonExt.stringify(showWelcomeOverlay),
      postWelcomeLaunchCount: '2',
      walletAccountsHadPreviousLife: 'false',
    });
    const { walletKeys } = createTestWallet('//Alice');
    instanceChecks.delete(Config.prototype.constructor);
    const config = new Config(Promise.resolve(db));
    const startup = new AppStartup(config, walletKeys, startupClients);
    await startup.initialize();
    await startup.recordLaunch();

    expect(config.postWelcomeLaunchCount).toBe(showWelcomeOverlay ? 2 : 3);
    expect((await db.configTable.fetchAllAsObject()).postWelcomeLaunchCount).toBe(showWelcomeOverlay ? '2' : '3');
    await db.close();
  },
);

it('loads a copied local-server configuration without activating the server', async () => {
  const dbPromise = createMockedDbPromise({
    serverDetails: JsonExt.stringify({
      ipAddress: '127.0.0.1',
      sshPort: 55116,
      sshUser: 'argon',
      type: ServerType.LocalComputer,
      workDir: '/app',
    }),
    serverAdd: JsonExt.stringify({ localComputer: {} }),
    isServerInstalled: 'true',
  });
  const activate = vi.spyOn(LocalMachine, 'activate').mockResolvedValue({ sshPort: 55222 } as any);
  const { walletKeys } = createTestWallet('//Alice', { canAccessServer: false });
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

  await new AppStartup(config, walletKeys, startupClients).initialize();

  expect(activate).not.toHaveBeenCalled();
  expect(config.serverDetails.sshPort).toBe(55116);
});

it('refreshes the local-server port while recovering an interrupted install', async () => {
  const dbPromise = createMockedDbPromise({
    serverDetails: JsonExt.stringify({
      ipAddress: '127.0.0.1',
      sshPort: 55116,
      sshUser: 'argon',
      type: ServerType.LocalComputer,
      workDir: '/app',
    }),
    serverAdd: JsonExt.stringify({ localComputer: {} }),
    isServerInstalling: 'true',
  });
  vi.spyOn(LocalMachine, 'activate').mockResolvedValue({ sshPort: 55222 });
  const save = vi.spyOn((await dbPromise).configTable, 'insertOrReplace');
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

  await new AppStartup(config, walletKeys, startupClients).initialize();

  expect(config.serverDetails.sshPort).toBe(55222);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ serverDetails: expect.stringContaining('55222') }));
});

it('returns a configured local server to installation when its VM no longer exists', async () => {
  const dbPromise = createMockedDbPromise({
    serverAdd: JsonExt.stringify({ localComputer: {} }),
    serverDetails: JsonExt.stringify({
      ipAddress: '127.0.0.1',
      sshPort: 55116,
      sshUser: 'argon',
      type: ServerType.LocalComputer,
      workDir: '/app',
    }),
    isServerInstalled: 'true',
  });
  const activate = vi.spyOn(LocalMachine, 'activate').mockResolvedValue(undefined);
  activate.mockClear();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise);

  await new AppStartup(config, walletKeys, startupClients).initialize();

  expect(config.serverAdd).toEqual({ localComputer: {} });
  expect(config.serverDetails).toEqual(Config.getDefault('serverDetails'));
  expect(config.isServerInstalled).toBe(false);
  expect(activate).toHaveBeenCalledOnce();
});
