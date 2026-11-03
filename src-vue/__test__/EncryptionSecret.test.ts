import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { nextTick, shallowReactive, watchEffect } from 'vue';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EncryptionSecret, type KeyProtection } from '../lib/EncryptionSecret.ts';
import { AccountSecurity } from '../lib/AccountSecurity.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { WalletSecrets } from '../lib/WalletSecrets.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { signatureVerify } from '@polkadot/util-crypto';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

// Native/OS boundary only. Production TypeScript supplies the AES key and chooses KDF parameters.
const syntheticKey = Buffer.alloc(32, 0x37);
const scope = 'com.argon.desktop/testnet/synthetic';
let record: { protection: KeyProtection; key?: Buffer; ciphertext?: string } | undefined;
let failAfterProtectionWrite: boolean;
let failProtectionRead: boolean;
beforeEach(() => {
  record = undefined;
  failAfterProtectionWrite = false;
  failProtectionRead = false;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, any> = {}) => {
    if (command === 'system_authentication_option') return null;
    if (command === 'keychain_info') {
      if (failProtectionRead) throw new Error('Synthetic keychain read temporarily unavailable');
      return record?.protection ?? null;
    }
    if (command === 'keychain_create') {
      if (record) throw new Error('This profile already has an encryption key');
      record = { protection: args.protection, key: Buffer.from(args.key) };
      return;
    }
    if (!record) throw new Error('The keychain encryption key is unavailable');
    let key: Buffer;
    if (record.protection.method === 'none') {
      key = record.key!;
    } else {
      if (!args.authentication.wrappingKey) throw new Error('An app passcode is required');
      key = decrypt(Buffer.from(args.authentication.wrappingKey), record.ciphertext!, scope);
    }
    if (command === 'keychain_encrypt') return encrypt(key, Buffer.from(args.plaintext));
    if (command === 'keychain_decrypt')
      return (args.ciphertexts as string[]).map(ciphertext => decrypt(key, ciphertext).toString('utf8'));
    if (command === 'keychain_authenticate') return;
    if (command === 'keychain_set_protection') {
      const protection: KeyProtection = args.protection;
      if (protection.method === 'none') record = { protection, key };
      else if (protection.method === 'passcode') {
        const ciphertext = encrypt(Buffer.from(args.newAuthentication.wrappingKey), key, scope);
        record = { protection, ciphertext };
      } else throw new Error('Unexpected hardware protection in this scenario');
      if (failAfterProtectionWrite) throw new Error('Synthetic write completed but its acknowledgement failed');
      return;
    }
    if (command === 'keychain_delete') {
      record = undefined;
      return;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});

it('matches decrypted text exactly and returns false when the key or ciphertext cannot decrypt it', async () => {
  const key = Uint8Array.from(syntheticKey);
  const plaintext = 'synthetic wallet secret';
  const ciphertext = encrypt(syntheticKey, Buffer.from(plaintext));

  await expect(EncryptionSecret.decryptsTo(key, ciphertext, plaintext)).resolves.toBe(true);
  await expect(EncryptionSecret.decryptsTo(key, ciphertext, plaintext.toUpperCase())).resolves.toBe(false);
  await expect(EncryptionSecret.decryptsTo(new Uint8Array(32), ciphertext, plaintext)).resolves.toBe(false);
  await expect(EncryptionSecret.decryptsTo(key, 'invalid ciphertext', plaintext)).resolves.toBe(false);
});

it('derives a compatible passcode wrapping key and preserves existing ciphertext through a passcode change', async () => {
  const secret = new EncryptionSecret();
  const key = Uint8Array.from(syntheticKey);
  await secret.create(key);
  expect(key).toEqual(new Uint8Array(32));
  const ciphertext = await secret.encrypt('synthetic imported wallet secret');
  const passcode = 'Several Unrelated Words';
  const security = new AccountSecurity();
  await security.ready;
  await secret.setProtection('passcode', { newPasscode: passcode });
  const info = await secret.info();
  if (info?.method !== 'passcode') throw new Error('Expected passcode protection');

  // Check against an independent KDF, so an incorrect production KDF cannot pass by round-tripping itself.
  const wrappingKey = scryptSync(passcode, Buffer.from(info.kdf.salt, 'hex'), 32, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  expect(decrypt(wrappingKey, record!.ciphertext!, scope)).toEqual(syntheticKey);
  expect(info).not.toHaveProperty('key');
  expect(info).not.toHaveProperty('ciphertext');
  await expect(secret.decrypt([ciphertext])).rejects.toThrow('An app passcode is required');
  await expect(secret.decrypt([ciphertext], { passcode: passcode.toLowerCase() })).rejects.toThrow();
  expect(await secret.decrypt([ciphertext], { passcode })).toEqual(['synthetic imported wallet secret']);

  await expect(
    secret.setProtection('passcode', { passcode: 'Wrong Passphrase', newPasscode: 'Different Unrelated Words' }),
  ).rejects.toThrow();
  expect(await secret.decrypt([ciphertext], { passcode })).toEqual(['synthetic imported wallet secret']);
  await secret.setProtection('passcode', { passcode, newPasscode: 'Different Unrelated Words' });
  await expect(secret.decrypt([ciphertext], { passcode })).rejects.toThrow();
  expect(await new EncryptionSecret().decrypt([ciphertext], { passcode: 'Different Unrelated Words' })).toEqual([
    'synthetic imported wallet secret',
  ]);

  const restarted = new AccountSecurity();
  await restarted.ready;
  expect(restarted.data.method).toBe('passcode');
  await secret.setProtection('none', { passcode: 'Different Unrelated Words' });
  await restarted.getSettings();
  expect(await secret.decrypt([ciphertext])).toEqual(['synthetic imported wallet secret']);
  expect(record!.key).toEqual(syntheticKey);
  expect(restarted.data.method).toBe('none');
});

it('reloads actual protection after an ambiguous settings write and can retry without changing encrypted data', async () => {
  const secret = new EncryptionSecret();
  await secret.create(Uint8Array.from(syntheticKey));
  const ciphertext = await secret.encrypt('synthetic saved wallet secret');
  const security = new AccountSecurity();
  security.data = shallowReactive(security.data);
  const observed: [boolean, KeyProtection['method']][] = [];
  const stopWatching = watchEffect(() => {
    observed.push([security.data.isLoaded, security.data.method]);
  });
  onTestFinished(stopWatching);
  await security.ready;
  const passcode = 'Several Unrelated Words';

  failAfterProtectionWrite = true;
  await expect(secret.setProtection('passcode', { newPasscode: passcode })).rejects.toThrow('acknowledgement');
  failAfterProtectionWrite = false;
  failProtectionRead = true;
  await expect(security.getSettings()).rejects.toThrow('temporarily unavailable');
  await nextTick();
  expect(security.data.isLoaded).toBe(false);
  expect(observed.at(-1)).toEqual([false, 'none']);

  failProtectionRead = false;
  await security.getSettings();
  await nextTick();
  expect(security.data.method).toBe('passcode');
  expect(security.data.isLoaded).toBe(true);
  expect(observed.at(-1)).toEqual([true, 'passcode']);
  expect(await secret.decrypt([ciphertext], { passcode })).toEqual(['synthetic saved wallet secret']);

  await secret.setProtection('none', { passcode });
  expect(await secret.decrypt([ciphertext])).toEqual(['synthetic saved wallet secret']);
  expect(record!.key).toEqual(syntheticKey);
});

it('keeps an existing key and ciphertext usable when a short new passcode is rejected', async () => {
  const secret = new EncryptionSecret();
  await secret.create(Uint8Array.from(syntheticKey));
  const ciphertext = await secret.encrypt('synthetic private data');
  await expect(secret.setProtection('passcode', { newPasscode: 'short' })).rejects.toThrow('at least 15 characters');
  expect(await secret.info()).toEqual({ method: 'none' });
  expect(await secret.decrypt([ciphertext])).toEqual(['synthetic private data']);
  const key = Uint8Array.from(syntheticKey);
  await expect(secret.create(key)).rejects.toThrow('already has an encryption key');
  expect(key).toEqual(new Uint8Array(32));
  expect(await secret.decrypt([ciphertext])).toEqual(['synthetic private data']);
});

it('decrypts a batch only with the current passcode and rejects a tampered secret', async () => {
  const secret = new EncryptionSecret();
  await secret.create(Uint8Array.from(syntheticKey));
  const plaintexts = ['synthetic recovery phrase', 'synthetic imported key'];
  const ciphertexts = await Promise.all(plaintexts.map(value => secret.encrypt(value)));
  const passcode = 'Several Unrelated Words';
  await secret.setProtection('passcode', { newPasscode: passcode });
  await expect(secret.decrypt(ciphertexts, { passcode: 'Incorrect Passphrase' })).rejects.toThrow();
  await expect(secret.decrypt(ciphertexts, { passcode })).resolves.toEqual(plaintexts);
  const tampered = Buffer.from(ciphertexts[1], 'base64');
  tampered[13] ^= 1;
  await expect(secret.decrypt([ciphertexts[0], tampered.toString('base64')], { passcode })).rejects.toThrow();
});

function encrypt(key: Buffer, plaintext: Buffer, context = ''): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

function decrypt(key: Buffer, ciphertext: string, context = ''): Buffer {
  const data = Buffer.from(ciphertext, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
}
