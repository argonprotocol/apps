import { invoke } from '@tauri-apps/api/core';
import type { SystemAuthenticationOption } from './tauriApi.ts';
import { EncryptionSecret, type EncryptionAuthentication, type KeyProtectionMethod } from './EncryptionSecret.ts';
import { WalletAuthenticationRequiredError, WalletRecoveryError, WalletSecrets } from './WalletSecrets.ts';
import { WalletKeys, WalletSigningUnavailableError } from './WalletKeys.ts';
import type { WalletsForEthereum } from './WalletsForEthereum.ts';
import type { Config } from './Config.ts';
import type { Db } from './Db.ts';
import type { IWalletFile } from '../interfaces/IWalletFile.ts';
import { cryptoWaitReady, mnemonicValidate } from '@polkadot/util-crypto';
import { miniSecretFromUri } from '@argonprotocol/apps-core';
import { hexToU8a } from '@argonprotocol/mainchain';

export type AccountSecurityMethod = KeyProtectionMethod;

export interface AccountAuthenticationPrompt {
  accessId?: number;
  reason: string;
  method: 'passcode' | 'system';
  canCancel?: boolean;
  verify: (passcode: string) => Promise<void>;
}

export interface AuthenticationOptions {
  accessId?: number;
  allowPrompt?: boolean;
  canCancel?: boolean;
}

export class AccountAuthenticationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AccountAuthenticationError';
  }
}

export class AccountSecurity {
  public static readonly minimumPasscodeLength = EncryptionSecret.minimumPasscodeLength;

  public data = {
    method: 'none' as AccountSecurityMethod,
    systemOption: null as SystemAuthenticationOption | null,
    isLoaded: false,
  };

  private settingsLoad?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly requestAuthentication?: (prompt: AccountAuthenticationPrompt) => Promise<void>) {}

  public get ready(): Promise<void> {
    return this.settingsLoad ?? this.getSettings();
  }

  public getSettings(): Promise<void> {
    this.settingsLoad = this.serialized(async () => {
      this.data.isLoaded = false;
      const [protection, systemOption] = await Promise.all([
        new EncryptionSecret().info(),
        invoke<SystemAuthenticationOption | null>('system_authentication_option'),
      ]);
      if (!protection) throw new Error('Your account encryption key is unavailable.');
      Object.assign(this.data, {
        method: protection.method,
        systemOption: systemOption === 'fingerprint' ? null : systemOption,
        isLoaded: true,
      });
    });
    return this.settingsLoad;
  }

  public request<T>(
    reason: string,
    operation: (authentication: EncryptionAuthentication) => Promise<T>,
    options: AuthenticationOptions = {},
  ): Promise<T> {
    return this.serialized(() => this.requestOperation(reason, operation, options));
  }

  public authenticate(reason: string): Promise<void> {
    return this.request(reason, authentication => new EncryptionSecret().authenticate(authentication));
  }

  public createBatch(reason: string): AccountSecurityBatch {
    return new AccountSecurityBatch(() => this.authenticate(reason));
  }

  public configure(
    {
      method,
      newPasscode,
      currentPasscode,
    }: {
      method: AccountSecurityMethod;
      newPasscode?: string;
      currentPasscode?: string;
    },
    {
      walletKeys,
      db,
      config,
      ethereumWallets,
    }: {
      walletKeys: WalletKeys;
      db: Db;
      config: Config;
      ethereumWallets?: WalletsForEthereum;
    },
  ): Promise<void> {
    return this.serialized(async () => {
      if (method === 'passcode' && [...(newPasscode ?? '')].length < AccountSecurity.minimumPasscodeLength) {
        throw new Error(`Use an app passcode with at least ${AccountSecurity.minimumPasscodeLength} characters.`);
      }
      this.settingsLoad = undefined;
      this.data.isLoaded = false;
      const secret = new EncryptionSecret();
      const current = await secret.info();
      if (!current) throw new Error('The account encryption key is unavailable.');
      if (current.method === 'none' && method !== 'none') {
        if (!config.certificationDetails?.hasSavedMnemonic) {
          throw new Error('Back up your mnemonic before enabling Account Security.');
        }
        await config.save();
      }

      try {
        if (!walletKeys.canSign) throw new WalletSigningUnavailableError();
        if (!walletKeys.secrets) throw new Error('No wallet secret source is loaded.');
        await AccountSecurity.setWalletProtection({ db, config }, walletKeys.secrets, method, {
          reason: 'change Account Security settings',
          passcode: currentPasscode,
          newPasscode,
        });
      } finally {
        // A keychain write can commit before the final wallet write reports a failure.
        // Refresh durable ciphertexts before another queued action can use loaded records.
        await ethereumWallets?.reloadRecords(true);
      }
      this.data.method = method;
      this.data.isLoaded = true;
    });
  }

  public static async matchesSavedMnemonic(mnemonic: string): Promise<boolean> {
    const phrase = mnemonic.trim().split(/\s+/).join(' ');
    if (!mnemonicValidate(phrase)) return false;
    await cryptoWaitReady();
    const wallet = await WalletSecrets.readSavedWallet();
    return wallet.meta?.vaultingAddress === WalletKeys.deriveIdentity(phrase).vaultingAddress;
  }

  public static async recoverWithNewPasscode({
    mnemonic,
    newPasscode,
    db,
    config,
  }: {
    mnemonic: string;
    newPasscode: string;
    db: Db;
    config: Config;
  }): Promise<void> {
    if ([...newPasscode].length < EncryptionSecret.minimumPasscodeLength) {
      throw new WalletRecoveryError(
        `Use an app passcode with at least ${EncryptionSecret.minimumPasscodeLength} characters.`,
      );
    }
    const phrase = mnemonic.trim().split(/\s+/).join(' ');
    if (!mnemonicValidate(phrase)) throw new WalletRecoveryError('Enter a valid recovery phrase.');
    await cryptoWaitReady();
    const wallet = await WalletSecrets.readSavedWallet();
    if (!wallet.meta || wallet.meta.vaultingAddress !== WalletKeys.deriveIdentity(phrase).vaultingAddress) {
      throw new WalletRecoveryError('The recovery phrase does not match this saved account.');
    }
    try {
      const encryption = new EncryptionSecret();
      const current = await encryption.info();
      const secrets = new WalletSecrets(wallet);
      if (current?.method === 'none') {
        const [savedMnemonic] = await encryption.decrypt([wallet.encryptedMnemonic]);
        if (savedMnemonic !== phrase) throw new Error('The saved account does not match its recovery phrase.');
        await AccountSecurity.setWalletProtection({ db, config }, secrets, 'passcode', { newPasscode });
        return;
      }

      await WalletSecrets.cleanupMnemonicFiles(phrase);
      const key = hexToU8a(miniSecretFromUri(`${phrase}//wallet-encryption`));
      try {
        const ciphertext = wallet.pendingKeyChange?.encryptedMnemonic ?? wallet.encryptedMnemonic;
        const matchesKey = await EncryptionSecret.decryptsTo(key, ciphertext, phrase);

        if (!matchesKey) {
          if (current) throw new Error('The protected account does not use its mnemonic-derived key.');
          await secrets.reencrypt(
            { db, config },
            { wallet, mnemonic: phrase, secrets: new Map() },
            { key, method: 'passcode', authentication: { passcode: newPasscode } },
          );
          return;
        }

        const recoveredWallet: IWalletFile = { ...wallet, encryptedMnemonic: ciphertext, protection: 'passcode' };
        await encryption.create(key, 'passcode', { passcode: newPasscode }, { replaceExisting: true });
        await secrets.save({ db, config }, recoveredWallet);
      } finally {
        key.fill(0);
      }
    } catch (error) {
      throw new WalletRecoveryError('Account recovery could not finish. Please try again.', {
        cause: error,
      });
    }
  }

  private static async setWalletProtection(
    storage: { db: Db; config: Config },
    secrets: WalletSecrets,
    method: KeyProtectionMethod,
    authentication: EncryptionAuthentication & { newPasscode?: string },
  ): Promise<void> {
    const encryption = new EncryptionSecret();
    const current = await encryption.info();
    if (!current) throw new Error('The account encryption key is unavailable.');
    let wallet = await secrets.readWallet();

    if (wallet.pendingKeyChange && current.method !== 'none') {
      await encryption.decrypt([wallet.pendingKeyChange.encryptedMnemonic], authentication);
      wallet = await secrets.save(storage, {
        ...wallet,
        encryptedMnemonic: wallet.pendingKeyChange.encryptedMnemonic,
        protection: current.method,
      });
      // Persist cleanup before disabling the protection that identifies a committed pending change.
      if (method === 'none') await secrets.save(storage, wallet);
    }
    if (current.method !== 'none') {
      await encryption.setProtection(method, authentication);
      await secrets.save(storage, { ...wallet, protection: method });
      return;
    }

    const [mnemonic] = await encryption.decrypt([wallet.encryptedMnemonic], authentication);
    if (method !== 'none') await WalletSecrets.cleanupMnemonicFiles(mnemonic);
    const key = hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`));
    try {
      const matchesKey = await EncryptionSecret.decryptsTo(key, wallet.encryptedMnemonic, mnemonic);
      if (matchesKey || method === 'none') {
        await encryption.setProtection(method, authentication);
        await secrets.save(storage, { ...wallet, protection: method });
        return;
      }

      const contents = await secrets.load(storage, wallet, authentication);
      await secrets.reencrypt(storage, contents, {
        key,
        method,
        authentication: { ...authentication, passcode: authentication.newPasscode },
      });
    } finally {
      key.fill(0);
    }
  }

  private async requestOperation<T>(
    reason: string,
    operation: (authentication: EncryptionAuthentication) => Promise<T>,
    {
      allowPrompt = true,
      canCancel = true,
      accessId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    }: AuthenticationOptions = {},
  ): Promise<T> {
    console.info('[SecurityAccess]', { event: 'access-requested', accessId, allowPrompt, canCancel });
    const protection = await new EncryptionSecret().info();
    if (!protection) throw new Error('The keychain encryption key is unavailable.');

    if (!allowPrompt && protection.method !== 'none') {
      console.info('[SecurityAccess]', { event: 'access-blocked', accessId, method: protection.method });
      throw new WalletAuthenticationRequiredError();
    }

    const method = protection.method;
    if (method === 'passcode' || (method === 'system' && !canCancel)) {
      if (!this.requestAuthentication)
        throw new AccountAuthenticationError('The Account Security prompt is unavailable. Please reopen the app.');
      let result!: T;
      let attempt = 0;
      try {
        console.info('[SecurityAccess]', { event: 'prompt-requested', accessId, method });
        await this.requestAuthentication({
          accessId,
          reason,
          method,
          canCancel,
          verify: async passcode => {
            console.info('[SecurityAccess]', { event: 'authentication-attempt', accessId, method, attempt: ++attempt });
            try {
              result = await operation({ reason, passcode, accessId });
              console.info('[SecurityAccess]', { event: 'authentication-succeeded', accessId, method, attempt });
            } catch (error) {
              console.info('[SecurityAccess]', { event: 'authentication-failed', accessId, method, attempt });
              throw error;
            }
          },
        });
      } catch (error) {
        console.info('[SecurityAccess]', { event: 'access-not-granted', accessId, method });
        throw new AccountAuthenticationError(error);
      }
      console.info('[SecurityAccess]', { event: 'access-granted', accessId, method });
      return result;
    }

    // System protection authenticates the actual native key read, not a separate confirmation.
    const result = await operation({ reason, accessId });
    console.info('[SecurityAccess]', { event: 'access-granted', accessId, method });
    return result;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}

export class AccountSecurityBatch {
  constructor(
    private readonly confirm: () => Promise<void>,
    private confirmation?: Promise<void>,
  ) {}

  public authenticate(): Promise<void> {
    this.confirmation ??= this.confirm().catch(error => {
      this.confirmation = undefined;
      throw error;
    });
    return this.confirmation;
  }
}
