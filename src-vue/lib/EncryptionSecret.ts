import { invoke } from '@tauri-apps/api/core';
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { z } from 'zod';
import { u8aConcat } from '@polkadot/util';
import { base64Decode, base64Encode } from '@polkadot/util-crypto';

// Represents this network/profile's keychain encryption key; retains no key bytes or unlocked state.
export class EncryptionSecret {
  public static readonly minimumPasscodeLength = 15;

  public static async encryptWithKey(key: Uint8Array, plaintexts: string[]): Promise<string[]> {
    const aes = await EncryptionSecret.importKey(key, ['encrypt']);
    const ciphertexts: string[] = [];
    for (const plaintext of plaintexts) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const bytes = new TextEncoder().encode(plaintext);
      try {
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, bytes);
        ciphertexts.push(base64Encode(u8aConcat(nonce, new Uint8Array(encrypted))));
      } finally {
        bytes.fill(0);
      }
    }
    return ciphertexts;
  }

  public static async decryptWithKey(key: Uint8Array, ciphertexts: string[]): Promise<string[]> {
    const aes = await EncryptionSecret.importKey(key, ['decrypt']);
    const plaintexts: string[] = [];
    for (const ciphertext of ciphertexts) {
      const bytes = Uint8Array.from(base64Decode(ciphertext));
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, aes, bytes.subarray(12)),
      );
      try {
        plaintexts.push(new TextDecoder().decode(plaintext));
      } finally {
        plaintext.fill(0);
      }
    }
    return plaintexts;
  }

  public static async decryptsTo(key: Uint8Array, ciphertext: string, expectedPlaintext: string): Promise<boolean> {
    try {
      const [plaintext] = await EncryptionSecret.decryptWithKey(key, [ciphertext]);
      return plaintext === expectedPlaintext;
    } catch {
      return false;
    }
  }

  public async info(): Promise<KeyProtection | null> {
    const protection = await invoke<unknown>('keychain_info');
    if (protection === null) return null;
    return protectionSchema.parse(protection);
  }

  /** Consumes the supplied key bytes and clears the temporary buffers after creation. */
  public async create(
    key: Uint8Array,
    method: KeyProtectionMethod = 'none',
    authentication: EncryptionAuthentication = {},
    { replaceExisting = false } = {},
  ): Promise<void> {
    const bytes = Array.from(key);
    const accessId = authentication.accessId ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    let wrappingKey: number[] | undefined;
    console.info('[SecurityAccess]', { event: 'keychain-requested', operation: 'create', accessId, method });
    try {
      const replacement = await this.prepareProtection(method, { ...authentication, accessId });
      wrappingKey = replacement.authentication.wrappingKey;
      await invoke('keychain_create', { ...replacement, key: bytes, replaceExisting });
      console.info('[SecurityAccess]', { event: 'keychain-completed', operation: 'create', accessId });
    } catch (error) {
      console.info('[SecurityAccess]', { event: 'keychain-failed', operation: 'create', accessId });
      throw error;
    } finally {
      key.fill(0);
      bytes.fill(0);
      wrappingKey?.fill(0);
    }
  }

  public write(value: string): Promise<void> {
    return invoke('keychain_write', { value });
  }

  public encrypt(plaintext: string, authentication: EncryptionAuthentication = {}): Promise<string> {
    return this.withNativeCredentials('encrypt', authentication, nativeAuthentication =>
      invoke('keychain_encrypt', { plaintext, authentication: nativeAuthentication }),
    );
  }

  public decrypt(ciphertexts: string[], authentication?: EncryptionAuthentication): Promise<string[]>;
  public decrypt(
    ciphertexts: string[],
    authentication: EncryptionAuthentication,
    requiredCount: number,
  ): Promise<(string | null)[]>;
  public decrypt(
    ciphertexts: string[],
    authentication: EncryptionAuthentication = {},
    requiredCount?: number,
  ): Promise<(string | null)[]> {
    return this.withNativeCredentials('decrypt', authentication, nativeAuthentication =>
      invoke('keychain_decrypt', { ciphertexts, authentication: nativeAuthentication, requiredCount }),
    );
  }

  public authenticate(authentication: EncryptionAuthentication = {}): Promise<void> {
    return this.withNativeCredentials('authenticate', authentication, nativeAuthentication =>
      invoke('keychain_authenticate', { authentication: nativeAuthentication }),
    );
  }

  public async setProtection(
    method: KeyProtectionMethod,
    { newPasscode, ...authentication }: EncryptionAuthentication & { newPasscode?: string } = {},
  ): Promise<void> {
    await this.withNativeCredentials('setProtection', authentication, async current => {
      const replacement = await this.prepareProtection(method, {
        ...authentication,
        accessId: current.accessId,
        passcode: newPasscode,
      });
      try {
        await invoke('keychain_set_protection', {
          protection: replacement.protection,
          authentication: current,
          newAuthentication: replacement.authentication,
        });
      } finally {
        replacement.authentication.wrappingKey?.fill(0);
      }
    });
  }

  public delete(authentication: EncryptionAuthentication = {}): Promise<void> {
    return this.withNativeCredentials('delete', authentication, nativeAuthentication =>
      invoke('keychain_delete', { authentication: nativeAuthentication }),
    );
  }

  private static async importKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
    const bytes = Uint8Array.from(key);
    try {
      return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, usages);
    } finally {
      bytes.fill(0);
    }
  }

  private async withNativeCredentials<T>(
    operationName: string,
    authentication: EncryptionAuthentication,
    operation: (authentication: NativeAuthentication) => Promise<T>,
  ): Promise<T> {
    const accessId = authentication.accessId ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const started = performance.now();
    console.info('[SecurityAccess]', { event: 'keychain-requested', operation: operationName, accessId });
    try {
      const protection = await this.info();
      if (!protection) throw new Error('The keychain encryption key is unavailable.');
      const nativeAuthentication = await this.prepareAuthentication(protection, { ...authentication, accessId });
      try {
        const result = await operation(nativeAuthentication);
        console.info('[SecurityAccess]', {
          event: 'keychain-completed',
          operation: operationName,
          accessId,
          method: protection.method,
          elapsedMs: Math.round(performance.now() - started),
        });
        return result;
      } finally {
        nativeAuthentication.wrappingKey?.fill(0);
      }
    } catch (error) {
      console.info('[SecurityAccess]', { event: 'keychain-failed', operation: operationName, accessId });
      throw error;
    }
  }

  private async prepareProtection(
    method: KeyProtectionMethod,
    authentication: EncryptionAuthentication,
  ): Promise<{ protection: KeyProtection; authentication: NativeAuthentication }> {
    if (method !== 'passcode') {
      return {
        protection: { method },
        authentication: {
          reason: authentication.reason ?? 'change Account Security',
          accessId: authentication.accessId,
        },
      };
    }
    if ([...(authentication.passcode ?? '')].length < EncryptionSecret.minimumPasscodeLength) {
      throw new Error(`Use an app passcode with at least ${EncryptionSecret.minimumPasscodeLength} characters.`);
    }
    const protection: KeyProtection = {
      method,
      kdf: { algorithm: 'scrypt', parameters: scryptParameters, salt: bytesToHex(randomBytes(16)) },
    };
    return { protection, authentication: await this.prepareAuthentication(protection, authentication) };
  }

  private async prepareAuthentication(
    protection: KeyProtection,
    { passcode, reason = 'access an encrypted secret', accessId }: EncryptionAuthentication,
  ): Promise<NativeAuthentication> {
    if (protection.method !== 'passcode') return { reason, accessId };
    if (passcode === undefined) throw new Error('An app passcode is required.');
    const bytes = await scryptAsync(passcode, hexToBytes(protection.kdf.salt), protection.kdf.parameters);
    try {
      return { reason, accessId, wrappingKey: Array.from(bytes) };
    } finally {
      bytes.fill(0);
    }
  }
}

export type EncryptionAuthentication = { passcode?: string; reason?: string; accessId?: number };
type NativeAuthentication = { reason: string; wrappingKey?: number[]; accessId?: number };

const scryptParameters = { N: 131072, r: 8, p: 1, dkLen: 32 } as const;
const protectionSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('none') }),
  z.object({ method: z.literal('system') }),
  z.object({
    method: z.literal('passcode'),
    kdf: z.object({
      algorithm: z.literal('scrypt'),
      parameters: z.object({
        N: z.literal(scryptParameters.N),
        r: z.literal(scryptParameters.r),
        p: z.literal(scryptParameters.p),
        dkLen: z.literal(scryptParameters.dkLen),
      }),
      salt: z.string().regex(/^[0-9a-f]{32}$/),
    }),
  }),
]);
export type KeyProtection = z.infer<typeof protectionSchema>;
export type KeyProtectionMethod = KeyProtection['method'];
