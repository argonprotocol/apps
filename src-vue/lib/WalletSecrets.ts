import { EncryptionSecret, type EncryptionAuthentication, type KeyProtectionMethod } from './EncryptionSecret.ts';
import type { AccountSecurity } from './AccountSecurity.ts';
import { walletFileSchema, type IWalletFile } from '../interfaces/IWalletFile.ts';
import type { Db } from './Db.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import type { Config } from './Config.ts';
import { miniSecretFromUri } from '@argonprotocol/apps-core';
import { hexToU8a } from '@argonprotocol/mainchain';
import { mnemonicValidate } from '@polkadot/util-crypto';

export class WalletRecoveryError extends Error {}

export class WalletAuthenticationRequiredError extends Error {
  constructor(message = 'Unlock this transaction to continue signing.') {
    super(message);
    this.name = 'WalletAuthenticationRequiredError';
  }
}

export class WalletSecrets {
  readonly #source: { encryptedMnemonic: string } | { mnemonic: string; substrateSuri?: string };
  readonly #accountSecurity?: AccountSecurity;

  constructor(
    source: { encryptedMnemonic: string } | { mnemonic: string; substrateSuri?: string },
    accountSecurity?: AccountSecurity,
  ) {
    this.#source = source;
    this.#accountSecurity = accountSecurity;
  }

  public static async prepareWallet(
    mnemonic: string,
    identity: NonNullable<IWalletFile['meta']>,
    mnemonicsToRemove: string[] = [],
  ) {
    if (!mnemonicValidate(mnemonic)) throw new Error('The mnemonic is invalid. No wallet file was changed.');
    const key = hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`));
    try {
      const [encryptedMnemonic, ...encryptedMnemonicCleanup] = await EncryptionSecret.encryptWithKey(key, [
        mnemonic,
        ...mnemonicsToRemove,
      ]);
      const wallet: IWalletFile = { encryptedMnemonic, meta: identity, protection: 'none' };
      return { wallet, encryptedMnemonicCleanup };
    } finally {
      key.fill(0);
    }
  }

  public static async saveWallet(mnemonic: string, identity: NonNullable<IWalletFile['meta']>, createNew = false) {
    if (!mnemonicValidate(mnemonic)) throw new Error('The mnemonic is invalid. No wallet file was changed.');
    const encryptionSecret = new EncryptionSecret();
    // First create the keychain key. Interrupted setup must not silently create a replacement account.
    const protection = await encryptionSecret.info();
    if (!protection) await encryptionSecret.create(hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`)));
    const encryptedMnemonic = await encryptionSecret.encrypt(mnemonic);
    const wallet: IWalletFile = { encryptedMnemonic, meta: identity, protection: protection?.method ?? 'none' };
    await invokeWithTimeout(
      'write_wallet_file',
      { filename: 'wallet.json', contents: JSON.stringify(wallet), createNew },
      30e3,
    );
    return { wallet, identity };
  }

  public static async readSavedWallet(): Promise<IWalletFile> {
    try {
      const pending = await invokeWithTimeout<string | null>('read_wallet_file', { filename: 'wallet.tmp.json' }, 30e3);
      if (pending !== null) {
        throw new WalletRecoveryError('An account import is still pending. Go back and choose Try again to finish it.');
      }
      let raw = await invokeWithTimeout<string | null>('read_wallet_file', { filename: 'wallet.json' }, 30e3);
      if (raw === null)
        raw = await invokeWithTimeout<string | null>('read_wallet_file', { filename: 'wallet.json.tmp' }, 30e3);
      if (raw === null) throw new Error('No saved wallet is available.');
      const wallet = JSON.parse(raw) as IWalletFile;
      walletFileSchema.parse(wallet);
      return wallet;
    } catch (error) {
      if (error instanceof WalletRecoveryError) throw error;
      throw new WalletRecoveryError('Your saved account could not be read.', { cause: error });
    }
  }

  public static async cleanupMnemonicFiles(mnemonic: string): Promise<void> {
    try {
      await invokeWithTimeout('cleanup_mnemonic_files', { mnemonic }, 30e3);
    } catch (error) {
      throw new Error('Could not remove old mnemonic files. Please try again.', { cause: error });
    }
  }

  public async getMnemonic(
    authentication?: EncryptionAuthentication,
    reason = 'reveal your recovery mnemonic',
  ): Promise<string> {
    if ('mnemonic' in this.#source) return this.#source.mnemonic;
    if (!this.#source.encryptedMnemonic) throw new Error('No encrypted mnemonic is loaded.');
    if (!authentication && this.#accountSecurity) {
      return this.#accountSecurity.request(reason, credentials => this.getMnemonic(credentials));
    }
    const [mnemonic] = await new EncryptionSecret().decrypt([this.#source.encryptedMnemonic], authentication);
    return mnemonic;
  }

  public async getSubstrateSuri(): Promise<string> {
    if ('mnemonic' in this.#source) return this.#source.substrateSuri ?? this.#source.mnemonic;
    return this.getMnemonic(undefined, 'sign with your account');
  }

  public async readWallet(): Promise<IWalletFile> {
    if ('mnemonic' in this.#source) throw new Error('Only a saved account can change its protection.');
    const raw = await invokeWithTimeout<string>('read_wallet_file', { filename: 'wallet.json' }, 30e3);
    const wallet = walletFileSchema.parse(JSON.parse(raw));
    if (
      this.#source.encryptedMnemonic !== wallet.encryptedMnemonic &&
      this.#source.encryptedMnemonic !== wallet.pendingKeyChange?.encryptedMnemonic
    ) {
      throw new Error('The saved account changed. Reopen the app before changing Account Security.');
    }
    return wallet;
  }

  public async load(
    { db, config }: { db: Db; config?: Config },
    wallet: IWalletFile,
    authentication: EncryptionAuthentication,
    { allowUnavailableSecrets = false } = {},
  ): Promise<DecryptedWalletSecrets> {
    const records = await db.walletsTable.fetchEthereumWallets();
    const configSecrets = config?.readEncryptedSecrets() ?? {};
    const ciphertexts = [
      ...records.flatMap(record => (record.encryptedSecret ? [record.encryptedSecret] : [])),
      ...Object.values(configSecrets),
    ];

    const isFinishingKeyChange = wallet.encryptedMnemonic === wallet.pendingKeyChange?.encryptedMnemonic;
    const encryptedSecrets = ciphertexts.map(ciphertext => {
      if (isFinishingKeyChange) return wallet.pendingKeyChange!.replacements[ciphertext] ?? ciphertext;
      return ciphertext;
    });
    const encryption = new EncryptionSecret();
    const encrypted = [wallet.encryptedMnemonic, ...encryptedSecrets];
    let decrypted: (string | null)[];
    if (allowUnavailableSecrets) decrypted = await encryption.decrypt(encrypted, authentication, 1);
    else decrypted = await encryption.decrypt(encrypted, authentication);

    const [mnemonic, ...plaintexts] = decrypted;
    const secrets = new Map<string, string>();
    for (const [index, ciphertext] of ciphertexts.entries()) {
      const plaintext = plaintexts[index];
      if (plaintext !== null) secrets.set(ciphertext, plaintext);
    }
    if (plaintexts.includes(null)) {
      console.warn('Some saved secrets could not be unlocked. Reconnect the affected wallets or services.');
    }
    return {
      wallet,
      mnemonic: mnemonic!,
      secrets,
    };
  }

  public async reencrypt(
    storage: { db: Db; config: Config },
    contents: DecryptedWalletSecrets,
    {
      key,
      method,
      authentication,
    }: {
      key: Uint8Array;
      method: Exclude<KeyProtectionMethod, 'none'>;
      authentication: EncryptionAuthentication;
    },
  ): Promise<void> {
    const { wallet } = contents;
    const [encryptedMnemonic, ...ciphertexts] = await EncryptionSecret.encryptWithKey(key, [
      contents.mnemonic,
      ...contents.secrets.values(),
    ]);
    const replacements = Object.fromEntries(
      [...contents.secrets.keys()].map((ciphertext, index) => [ciphertext, ciphertexts[index]]),
    );
    const prepared = { ...wallet, pendingKeyChange: { encryptedMnemonic, replacements } };
    await this.save(storage, prepared);
    await new EncryptionSecret().create(key, method, authentication, { replaceExisting: true });
    await this.save(storage, { ...prepared, encryptedMnemonic, protection: method });
  }

  /** Persist wallet ciphertext already authenticated with the active key. */
  public async save({ db, config }: { db: Db; config: Config }, wallet: IWalletFile): Promise<IWalletFile> {
    if ('mnemonic' in this.#source) throw new Error('Only a saved account can change its protection.');
    const pending = wallet.pendingKeyChange;
    if (!pending || wallet.encryptedMnemonic !== pending.encryptedMnemonic) {
      await WalletSecrets.writeWallet(wallet);
      this.#source.encryptedMnemonic = wallet.encryptedMnemonic;
      return wallet;
    }

    this.#source.encryptedMnemonic = pending.encryptedMnemonic;
    await db.transaction(async transaction => {
      for (const record of await transaction.walletsTable.fetchEthereumWallets()) {
        const replacement = record.encryptedSecret && pending.replacements[record.encryptedSecret];
        if (replacement) await transaction.walletsTable.insert({ ...record, encryptedSecret: replacement });
      }
      await config.replaceEncryptedSecrets(pending.replacements, transaction);
    });
    const { pendingKeyChange, ...committed } = wallet;
    committed.encryptedMnemonic = pending.encryptedMnemonic;
    try {
      await WalletSecrets.writeWallet(committed);
    } catch {
      console.warn('Account protection is active; pending wallet cleanup will retry when the account opens.');
    }
    return committed;
  }

  private static writeWallet(wallet: IWalletFile): Promise<void> {
    return invokeWithTimeout(
      'write_wallet_file',
      {
        filename: 'wallet.json',
        contents: JSON.stringify(wallet),
        createNew: false,
      },
      30e3,
    );
  }
}

type DecryptedWalletSecrets = {
  wallet: IWalletFile;
  mnemonic: string;
  secrets: Map<string, string>;
};
