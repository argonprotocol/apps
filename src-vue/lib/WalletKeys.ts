// prettier-ignore
import { Accountset, getRange, miniSecretFromUri, TxSigner } from '@argonprotocol/apps-core';
import { hexToU8a, Keyring, KeyringPair, u8aToHex } from '@argonprotocol/mainchain';
import {
  BitcoinNetwork,
  bip39,
  getBip32Version,
  getCompressedPubkey,
  getScureNetwork,
  HDKey,
  p2wpkh,
} from '@argonprotocol/bitcoin';
import type { Hex, Signature } from 'viem';
import type { WalletForEthereum } from './WalletForEthereum.ts';
import {
  EthereumKeys,
  EthereumSigner,
  toArgonEthereumSignature,
  ETHEREUM_HD_PREFIXES,
  getEthereumHdPath,
  assertEthereumHdPath,
} from './EthereumKeys.ts';
import { WalletSecrets } from './WalletSecrets.ts';
import { BitcoinSigner } from './BitcoinSigner.ts';
import { AccountAuthenticationError, type AccountSecurity } from './AccountSecurity.ts';
import { bootstrapEndpointPath, walletKeyPaths } from './WalletKeyPaths.ts';
import { EncryptionSecret, type EncryptionAuthentication, type KeyProtection } from './EncryptionSecret.ts';
import { ed25519 } from '@noble/curves/ed25519';
import { walletFileSchema, type IWalletFile } from '../interfaces/IWalletFile.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { NETWORK_NAME } from './Env.ts';
import { WalletType } from './Wallet.ts';
import {
  cryptoWaitReady,
  mnemonicValidate,
  mnemonicGenerate,
  ed25519DeriveHard,
  keyExtractPath,
} from '@polkadot/util-crypto';
import { formatEd25519PublicKey } from './SSH.ts';
import type { IWalletRecord } from './db/WalletsTable.ts';
import type { Db } from './Db.ts';
import type { Config } from './Config.ts';

export class WalletSigningUnavailableError extends Error {
  constructor() {
    super('Wallet signing is unavailable');
    this.name = 'WalletSigningUnavailableError';
  }
}

// Startup may display these messages; the original diagnostic stays in cause for logging.
export class WalletLoadError extends Error {}

export function isWalletSigningUnavailableError(error: unknown): error is WalletSigningUnavailableError {
  return error instanceof WalletSigningUnavailableError;
}

type WalletCapabilities = {
  canSign: boolean;
  canAccessServer: boolean;
};

export class WalletKeys {
  public readonly canSign: boolean;
  public readonly canAccessServer: boolean;
  public sshPublicKey = '';
  /**
   * Default Argon wallet used for user capital.
   */
  public defaultArgonAddress: string;
  public defaultArgonKeyReference: string;
  public legacyMiningHoldAddress = '';
  public legacyVaultingAddress: string;
  /**
   * Address used for mining bidding, rewards and transaction fees.
   */
  public miningBotAddress: string;
  /**
   * Address registered with mainchain as the vault operator. This account reserves 1 argon as a minimum balance.
   */
  public vaultingAddress: string;

  /**
   * Operational account for ongoing app operations.
   */
  public operationalAddress: string;
  /**
   * Ethereum-compatible address used for EVM/Ethereum integrations tied to this wallet.
   */
  public readonly coreEthereumAddress: string;
  public ethereumHdPath: `m/44'/60'/${string}`;
  public councilSignerEthereumHdPath: `m/44'/60'/${string}`;

  public miningBotSubaccountsCache: { [address: string]: { index: number } } = {};
  #sessionCredentials?: {
    operational: KeyringPair;
    upstreamOperatorAuth: KeyringPair;
    sshPrivateKeySeed: Uint8Array;
    upstreamEndpointRecoverySeed: string;
    operationalEncryptionPublicKey: Uint8Array;
    hdRoot: HDKey;
    sr25519Root: KeyringPair;
    ed25519Root: Uint8Array;
  };
  private readonly ethereumKeys: EthereumKeys;
  #externalEthereumSigners = new Map<string, EthereumSigner>();

  constructor(
    identity: ReturnType<typeof WalletKeys.deriveIdentity>,
    public readonly secrets?: WalletSecrets,
    capabilities: WalletCapabilities = { canSign: true, canAccessServer: true },
  ) {
    this.ethereumKeys = new EthereumKeys(secrets);
    this.canSign = capabilities.canSign;
    this.canAccessServer = capabilities.canAccessServer;
    this.defaultArgonAddress = identity.vaultingAddress;
    this.defaultArgonKeyReference = '//vaulting';
    this.legacyVaultingAddress = identity.vaultingAddress;
    this.miningBotAddress = identity.miningBotAddress;
    this.vaultingAddress = this.defaultArgonAddress;
    this.operationalAddress = identity.operationalAddress;
    this.coreEthereumAddress = identity.ethereumAddress.toLowerCase();
    this.ethereumHdPath = getEthereumHdPath(ETHEREUM_HD_PREFIXES.primary);
    this.councilSignerEthereumHdPath = getEthereumHdPath(ETHEREUM_HD_PREFIXES.councilSigner);
    if (NETWORK_NAME === 'dev-docker') {
      console.log('WalletKeys initialized with mining address:', this.miningBotAddress);
    }
  }

  // Wallet lifecycle

  public static fromMnemonic(
    mnemonic: string,
    options: {
      substrateSuri?: string;
      canSign?: boolean;
      canAccessServer?: boolean;
    } = {},
  ): WalletKeys {
    const { substrateSuri = mnemonic, canSign = true, canAccessServer = true } = options;
    const identity = WalletKeys.deriveIdentity(mnemonic, substrateSuri);
    const secrets = new WalletSecrets({ mnemonic, substrateSuri });
    const keys = new WalletKeys(identity, secrets, { canSign, canAccessServer });
    if (canSign) keys.initializeSession(substrateSuri, mnemonic);
    return keys;
  }

  public static async load(
    { db, config }: { db: Db; config: Config },
    accountSecurity: AccountSecurity,
    {
      defaultArgonWallet,
      authentication,
    }: {
      defaultArgonWallet?: IWalletRecord;
      authentication?: EncryptionAuthentication;
    } = {},
  ): Promise<{ walletKeys: WalletKeys; didChangeEncryptionKey?: boolean }> {
    await cryptoWaitReady();

    // Prefer the committed wallet. A staged first wallet can be completed after interruption.
    let walletFilename = 'wallet.json';
    let raw: string | null;
    try {
      raw = await invokeWithTimeout<string | null>('read_wallet_file', { filename: walletFilename }, 30e3);
      if (raw === null) {
        walletFilename = 'wallet.json.tmp';
        raw = await invokeWithTimeout<string | null>('read_wallet_file', { filename: walletFilename }, 30e3);
      }
    } catch (error) {
      throw new WalletLoadError('Your saved account could not be read.', { cause: error });
    }

    // Create an account only when no wallet or saved encryption key already owns this profile.
    if (raw === null) {
      if (await new EncryptionSecret().info()) {
        throw new WalletLoadError('Your saved account could not be found.', {
          cause: new Error('No wallet or pending wallet file exists, but an encryption key is already saved.'),
        });
      }
      const plaintext = await invokeWithTimeout<string | null>('read_mnemonic_file', {}, 30e3);
      const mnemonic = plaintext?.trim() ?? mnemonicGenerate(12);
      if (!mnemonicValidate(mnemonic)) throw new Error('The mnemonic is invalid. No wallet file was changed.');
      const identity = WalletKeys.deriveIdentity(mnemonic);
      const { wallet } = await WalletSecrets.saveWallet(mnemonic, identity, true);
      const keys = new WalletKeys(identity, new WalletSecrets(wallet, accountSecurity));
      if (defaultArgonWallet)
        keys.configureDefaultArgonWallet({
          address: defaultArgonWallet.address,
          keyReference: defaultArgonWallet.keyReference ?? '//vaulting',
        });
      keys.initializeSession(mnemonic);
      await config.unlock(new Map(), authentication ?? {});
      return { walletKeys: keys };
    }

    let wallet: IWalletFile;
    try {
      wallet = walletFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new WalletLoadError('Your saved account could not be read.', { cause: error });
    }

    let protection: KeyProtection | null = null;
    if (wallet.encryptedMnemonic) {
      try {
        protection = await new EncryptionSecret().info();
      } catch {
        // The decryption attempt below handles unavailable keychain access alongside public metadata.
      }
    }

    const isFinishingKeyChange = !!wallet.pendingKeyChange && !!protection && protection.method !== 'none';
    if (isFinishingKeyChange) wallet.encryptedMnemonic = wallet.pendingKeyChange!.encryptedMnemonic;
    const secrets = new WalletSecrets(wallet, accountSecurity);
    const externalWallets = (await db.walletsTable.fetchEthereumWallets()).filter(record => !!record.encryptedSecret);
    let decryptedSecrets: Map<string, string>;
    let keys: WalletKeys;
    let mnemonic: string;
    try {
      if (!wallet.encryptedMnemonic) throw new Error('No encrypted mnemonic is loaded.');
      try {
        const decrypt = async (credentials: EncryptionAuthentication) => {
          const contents = await secrets.load({ db, config }, wallet, credentials, { allowUnavailableSecrets: true });
          await config.unlock(contents.secrets, credentials);
          return contents;
        };
        const contents = authentication
          ? await decrypt(authentication)
          : await accountSecurity.request('unlock your account', decrypt);
        mnemonic = contents.mnemonic;
        decryptedSecrets = contents.secrets;
      } catch (error) {
        if (error instanceof AccountAuthenticationError) throw error;
        if (protection?.method === 'passcode') {
          throw new WalletLoadError('Could not unlock your account. Check your app passcode and try again.', {
            cause: error,
          });
        }
        throw new WalletLoadError('Your device could not unlock this account. Please try again.', { cause: error });
      }
      if (!mnemonic) throw new WalletLoadError('Your device did not unlock this account. Please try again.');
      if (!mnemonicValidate(mnemonic)) throw new WalletLoadError('Your saved recovery phrase is invalid.');
      const identity = WalletKeys.deriveIdentity(mnemonic);
      if (wallet.meta && wallet.meta.vaultingAddress !== identity.vaultingAddress) {
        throw new WalletLoadError('Your saved account does not match its recovery phrase.');
      }
      if (isFinishingKeyChange) {
        wallet = await secrets.save({ db, config }, { ...wallet, protection: protection!.method });
      }
      keys = new WalletKeys(identity, secrets);
      if (defaultArgonWallet)
        keys.configureDefaultArgonWallet({
          address: defaultArgonWallet.address,
          keyReference: defaultArgonWallet.keyReference ?? '//vaulting',
        });
      keys.initializeSession(mnemonic);
    } catch (error) {
      if (error instanceof AccountAuthenticationError) throw error;
      if (protection && protection.method !== 'none') throw error;
      if (wallet.protection !== 'none' || wallet.pendingKeyChange) throw error;
      if (walletFilename === 'wallet.json.tmp') throw error;
      if (!wallet.meta) throw error;
      if (!wallet.meta.ethereumAddress && wallet.encryptedMnemonic) throw error;
      console.warn('Wallet signing is unavailable; loading the saved public identity readonly.', error);
      return { walletKeys: new WalletKeys(wallet.meta, secrets, { canSign: false, canAccessServer: false }) };
    }

    for (const record of externalWallets) {
      const secret = decryptedSecrets.get(record.encryptedSecret!);
      if (secret === undefined) continue;
      try {
        keys.initializeEthereumWallet(record, secret);
      } catch {
        console.warn('An imported Ethereum wallet could not be unlocked. Reconnect it to restore signing access.');
      }
    }

    if (walletFilename === 'wallet.json.tmp') {
      try {
        await invokeWithTimeout('write_wallet_file', { filename: 'wallet.json', contents: raw, createNew: true }, 30e3);
      } catch (error) {
        throw new WalletLoadError('Your account could not be saved. Please try again.', { cause: error });
      }
    }
    return {
      walletKeys: keys,
      didChangeEncryptionKey: isFinishingKeyChange,
    };
  }

  public static deriveIdentity(mnemonic: string, substrateSuri = mnemonic): NonNullable<IWalletFile['meta']> {
    const keyring = new Keyring({ type: 'sr25519' });
    return {
      miningBotAddress: keyring.createFromUri(`${substrateSuri}${walletKeyPaths.mining}`).address,
      vaultingAddress: keyring.createFromUri(`${substrateSuri}//vaulting`).address,
      operationalAddress: keyring.createFromUri(`${substrateSuri}${walletKeyPaths.operational}`).address,
      ethereumAddress: EthereumKeys.accountFromMnemonic(mnemonic, getEthereumHdPath(ETHEREUM_HD_PREFIXES.primary))
        .address,
    };
  }

  // Secret access

  public async exposeMasterMnemonic(): Promise<string> {
    this.requireSigningAccess();
    if (!this.secrets) throw new Error('No wallet secret source is loaded.');
    return this.secrets.getMnemonic();
  }

  public async matchesMnemonic(mnemonic: string): Promise<boolean> {
    const phrase = mnemonic.trim().split(/\s+/).join(' ');
    if (!mnemonicValidate(phrase)) return false;
    await cryptoWaitReady();
    const mining = new Keyring({ type: 'sr25519' }).addFromUri(`${phrase}${walletKeyPaths.mining}`);
    return mining.address === this.miningBotAddress;
  }

  public async exportEthereumPrivateKey(): Promise<Hex> {
    this.requireSigningAccess();
    return this.ethereumKeys.getPrivateKey();
  }

  public async exportDefaultArgonPrivateKey(): Promise<string> {
    this.requireSigningAccess();
    if (!this.secrets) throw new Error('No wallet secret source is loaded.');
    const mnemonic = await this.secrets.getSubstrateSuri();
    const seed = await invokeWithTimeout<number[]>(
      'export_sr25519_seed',
      { suri: `${mnemonic}${this.defaultArgonKeyReference}` },
      60e3,
    );
    return u8aToHex(Uint8Array.from(seed));
  }

  // Session credentials

  public initializeSession(substrateSuri: string, mnemonic = substrateSuri): void {
    this.requireSigningAccess();
    const keyring = new Keyring({ type: 'sr25519' });
    const operational = keyring.createFromUri(`${substrateSuri}${walletKeyPaths.operational}`);
    if (operational.address !== this.operationalAddress) {
      throw new Error('Session credentials do not match the current account.');
    }

    const sshPrivateKeySeed = hexToU8a(miniSecretFromUri(`${substrateSuri}//ssh-ed25519//1`));
    const operationalEncryptionSeed = hexToU8a(miniSecretFromUri(`${substrateSuri}//operational//encrypt`));
    const operationalEncryptionPublicKey = ed25519.utils.toMontgomery(ed25519.getPublicKey(operationalEncryptionSeed));
    operationalEncryptionSeed.fill(0);
    this.sshPublicKey = formatEd25519PublicKey(ed25519.getPublicKey(sshPrivateKeySeed));
    this.legacyMiningHoldAddress = keyring.createFromUri(`${substrateSuri}//holding`).address;
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    let hdRoot: HDKey;
    try {
      hdRoot = HDKey.fromMasterSeed(seed);
    } finally {
      seed.fill(0);
    }
    this.#sessionCredentials?.hdRoot.wipePrivateData();
    this.#sessionCredentials = {
      operational,
      upstreamOperatorAuth: keyring.createFromUri(`${substrateSuri}//upstream-operator-auth`),
      sshPrivateKeySeed,
      upstreamEndpointRecoverySeed: miniSecretFromUri(`${substrateSuri}${walletKeyPaths.upstreamRecovery}`),
      operationalEncryptionPublicKey,
      hdRoot,
      sr25519Root: keyring.createFromUri(substrateSuri),
      ed25519Root: hexToU8a(miniSecretFromUri(substrateSuri)),
    };
  }

  public async getOperationalSigner(): Promise<TxSigner> {
    const pair = this.getSessionCredentials().operational;
    return new TxSigner(pair);
  }

  public async getUpstreamOperatorAuthSigner(): Promise<TxSigner> {
    const pair = this.getSessionCredentials().upstreamOperatorAuth;
    return new TxSigner(pair);
  }

  public async getOperationalEncryptionKeypair(): Promise<Uint8Array> {
    return this.getSessionCredentials().operationalEncryptionPublicKey;
  }

  public async getSshPrivateKeySeed(): Promise<Uint8Array> {
    if (!this.canAccessServer) throw new Error('Server access is unavailable');
    return this.getSessionCredentials().sshPrivateKeySeed;
  }

  public async getMiningBotSubaccounts(count = 144): Promise<{ [address: string]: { index: number } }> {
    const currentCount = Object.keys(this.miningBotSubaccountsCache).length;
    if (currentCount >= count) {
      return this.miningBotSubaccountsCache;
    }

    const indexes = getRange(currentCount, count);
    for (const index of indexes) {
      const address = Accountset.createMiningSubaccount(this.miningBotAddress, index);
      this.miningBotSubaccountsCache[address] = { index };
    }
    return this.miningBotSubaccountsCache;
  }

  public async getOwnServerBootstrapEndpointSecret(index = 0): Promise<string> {
    return this.deriveEd25519Seed(bootstrapEndpointPath(index));
  }

  public async getUpstreamEndpointRecoverySeed(): Promise<string> {
    return this.getSessionCredentials().upstreamEndpointRecoverySeed;
  }

  public async getOwnServerEndpointRecoverySeed(): Promise<string> {
    return this.deriveEd25519Seed(walletKeyPaths.ownServerRecovery);
  }

  // Public keys are derived from the session opened by startup, never another keychain read.

  public async getBitcoinPublicKey(
    hdPath: string,
    network: BitcoinNetwork,
  ): Promise<Pick<HDKey, 'publicKey' | 'publicExtendedKey'>> {
    const root = this.getSessionCredentials().hdRoot;
    const node = root.derive(hdPath);
    try {
      const publicNode = new HDKey({
        versions: getBip32Version(network) ?? BITCOIN_VERSIONS[network as keyof typeof BITCOIN_VERSIONS],
        publicKey: node.publicKey!,
        chainCode: node.chainCode!,
        depth: node.depth,
        index: node.index,
        parentFingerprint: node.parentFingerprint,
      });
      return { publicKey: publicNode.publicKey, publicExtendedKey: publicNode.publicExtendedKey };
    } finally {
      if (node !== root) node.wipePrivateData();
    }
  }

  public getMintingAuthorityEthereumHdPath(hdIndex: number): `m/44'/60'/${string}` {
    return getEthereumHdPath(ETHEREUM_HD_PREFIXES.mintingAuthority, hdIndex);
  }

  public getMintingAuthorityEthereumHdPaths(count: number, startIndex = 0): `m/44'/60'/${string}`[] {
    return Array.from({ length: count }, (_, offset) => this.getMintingAuthorityEthereumHdPath(startIndex + offset));
  }

  public async getEthereumAddresses(hdPaths: string[]): Promise<string[]> {
    const root = this.getSessionCredentials().hdRoot;
    return hdPaths.map(path => {
      assertEthereumHdPath(path);
      const node = root.derive(path);
      try {
        return EthereumKeys.parsePrivateKey(u8aToHex(node.privateKey)).address.toLowerCase();
      } finally {
        node.wipePrivateData();
      }
    });
  }

  // Signing and wallet selection

  public async getArgonSigner(path = this.defaultArgonKeyReference): Promise<TxSigner> {
    const pair = this.getSessionCredentials().sr25519Root.derive(path);
    return new TxSigner(pair);
  }

  public async getDefaultArgonSigner(): Promise<TxSigner> {
    return this.getArgonSigner();
  }
  public async getVaultingSigner(): Promise<TxSigner> {
    return this.getArgonSigner();
  }
  public async getMiningBotSigner(): Promise<TxSigner> {
    return this.getArgonSigner(walletKeyPaths.mining);
  }
  public async getMiningBidProxySigner(): Promise<TxSigner> {
    return this.getArgonSigner(walletKeyPaths.miningProxy);
  }
  public async getVaultDelegateSigner(): Promise<TxSigner> {
    return this.getArgonSigner(walletKeyPaths.vaultDelegate);
  }
  public async getLegacyMiningHoldSigner(): Promise<TxSigner> {
    return this.getArgonSigner('//holding');
  }
  public async getLiquidLockingSigner(): Promise<TxSigner> {
    return this.getDefaultArgonSigner();
  }
  public async getTreasurySigner(): Promise<TxSigner> {
    return this.getDefaultArgonSigner();
  }
  public async getWalletSigner(type: WalletType): Promise<TxSigner> {
    return this.getArgonSigner(this.getWalletKeyReference(type));
  }

  public async getBitcoinSigner(hdPath: string, network: BitcoinNetwork): Promise<BitcoinSigner> {
    const root = this.getSessionCredentials().hdRoot;
    const child = root.derive(hdPath);
    try {
      const key = new HDKey({
        versions: getBip32Version(network),
        privateKey: child.privateKey!,
        chainCode: child.chainCode!,
        depth: child.depth,
        index: child.index,
        parentFingerprint: child.parentFingerprint,
      });
      return new BitcoinSigner(key, network);
    } finally {
      if (child !== root) child.wipePrivateData();
    }
  }

  public async getEthereumSigner(hdPath = this.ethereumHdPath, wallet?: WalletForEthereum): Promise<EthereumSigner> {
    if (wallet && !this.isCoreEthereumAddress(wallet.address)) {
      const signer = this.#externalEthereumSigners.get(wallet.address.toLowerCase());
      if (!signer) throw new Error('The imported Ethereum wallet is not unlocked. Reconnect it to continue.');
      return signer;
    }
    assertEthereumHdPath(hdPath);
    const key = this.getSessionCredentials().hdRoot.derive(hdPath);
    try {
      return this.ethereumKeys.createSigner(u8aToHex(key.privateKey));
    } finally {
      key.wipePrivateData();
    }
  }

  public initializeEthereumWallet(record: IWalletRecord, secret: string): void {
    let privateKey: Hex;
    if (record.secretKind === 'privateKey') privateKey = EthereumKeys.parsePrivateKey(secret).privateKey;
    else if (record.secretKind === 'mnemonic' && record.derivationPath)
      privateKey = u8aToHex(EthereumKeys.accountFromMnemonic(secret, record.derivationPath).getHdKey().privateKey);
    else throw new Error('The imported wallet has no supported derivation.');
    const signer = this.ethereumKeys.createSigner(privateKey);
    if (signer.address.toLowerCase() !== record.address.toLowerCase()) {
      signer.close();
      throw new Error('The imported wallet secret does not match its address.');
    }
    this.removeEthereumWallet(record.address);
    this.#externalEthereumSigners.set(record.address.toLowerCase(), signer);
  }

  public removeEthereumWallet(address: string): void {
    this.#externalEthereumSigners.get(address.toLowerCase())?.close();
    this.#externalEthereumSigners.delete(address.toLowerCase());
  }

  public async signEthereumPersonalMessage(
    message: string,
    hdPath = this.ethereumHdPath,
    format: 'ethereum' | 'argon' = 'ethereum',
  ): Promise<Hex> {
    const trimmedMessage = message.trim();
    if (trimmedMessage.startsWith('0x') && !/^0x(?:[a-fA-F0-9]{2})*$/.test(trimmedMessage)) {
      throw new Error('An Ethereum hex message must contain complete bytes.');
    }
    const signer = await this.getEthereumSigner(hdPath);
    const signature = await signer.signMessage({
      message: trimmedMessage.startsWith('0x') ? { raw: trimmedMessage as Hex } : trimmedMessage,
    });
    return format === 'argon' ? toArgonEthereumSignature(signature) : signature;
  }

  public async signEthereumTransaction(
    unsignedTransaction: Hex,
    hdPath = this.ethereumHdPath,
    wallet?: WalletForEthereum,
  ): Promise<Signature> {
    return (await this.getEthereumSigner(hdPath, wallet)).signEthereumTransaction(unsignedTransaction);
  }

  public async signEthereumPermit(args: {
    tokenAddress: string;
    tokenName: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
    wallet?: WalletForEthereum;
  }): Promise<{ v: number; r: string; s: string }> {
    const { wallet, ...permit } = args;
    return (await this.getEthereumSigner(this.ethereumHdPath, wallet)).signEthereumPermit(permit);
  }

  private getEd25519Seed(path: string): Uint8Array {
    let seed: Uint8Array = Uint8Array.from(this.getSessionCredentials().ed25519Root);
    for (const junction of keyExtractPath(path).path) {
      if (!junction.isHard) throw new Error('Ed25519 derivation requires a hard path');
      const child = ed25519DeriveHard(seed, junction.chainCode);
      seed.fill(0);
      seed = child;
    }
    return seed;
  }

  public async exportMiningBidProxyAccountJson(passphrase: string) {
    return this.getSessionCredentials().sr25519Root.derive(walletKeyPaths.miningProxy).toJson(passphrase);
  }

  public async exportMiningBotAccountJson(passphrase: string) {
    return this.getSessionCredentials().sr25519Root.derive(walletKeyPaths.mining).toJson(passphrase);
  }

  public async exportVaultDelegateAccountJson(passphrase: string) {
    return this.getSessionCredentials().sr25519Root.derive(walletKeyPaths.vaultDelegate).toJson(passphrase);
  }

  public async getRouterRestoreSealingKey(): Promise<string> {
    return this.deriveEd25519Seed(walletKeyPaths.routerRestoreSealing);
  }

  public async getMiningSessionMiniSecret(): Promise<string> {
    return this.deriveEd25519Seed(walletKeyPaths.miningSessions);
  }

  public configureDefaultArgonWallet(args: { address: string; keyReference: string }): void {
    this.defaultArgonAddress = args.address;
    this.defaultArgonKeyReference = args.keyReference;
    this.vaultingAddress = args.address;
  }

  public async configureEthereumSignerPolicy(args: {
    chainId: number;
    gatewayAddress: string;
    tokenAddresses: string[];
  }): Promise<void> {
    await this.ethereumKeys.configureEthereumSignerPolicy(args);
  }

  public isCoreEthereumAddress(address: string): boolean {
    return address.toLowerCase() === this.coreEthereumAddress;
  }

  public isCoreEthereumWallet(record?: IWalletRecord): boolean {
    return record?.walletType === 'ethereum' && this.isCoreEthereumAddress(record.address);
  }

  public getWalletKeyReference(walletType: WalletType): string {
    if (walletType === WalletType.argon) return this.defaultArgonKeyReference;
    if (walletType === WalletType.miningBot) return walletKeyPaths.mining;
    if (walletType === WalletType.operational) return '//operational';
    throw new Error('This wallet does not use an Argon signer.');
  }

  public getWalletAddress(walletType: WalletType): string {
    switch (walletType) {
      case WalletType.argon:
        return this.defaultArgonAddress;
      case WalletType.miningBot:
        return this.miningBotAddress;
      case WalletType.operational:
        return this.operationalAddress;
      case WalletType.ethereum:
        return this.coreEthereumAddress;
      case WalletType.bitcoin:
        throw new Error('Bitcoin wallet addresses are managed by WalletForBitcoin.');
    }

    throw new Error('Unsupported wallet type.');
  }

  public get liquidLockingAddress(): string {
    return this.defaultArgonAddress;
  }

  public get treasuryAddress(): string {
    return this.defaultArgonAddress;
  }

  // Internal helpers

  protected requireSigningAccess(): void {
    if (!this.canSign) throw new WalletSigningUnavailableError();
  }

  private getSessionCredentials() {
    this.requireSigningAccess();
    if (!this.#sessionCredentials) throw new Error('Wallet session is not initialized');
    return this.#sessionCredentials;
  }

  private async deriveEd25519Seed(path: string): Promise<string> {
    return u8aToHex(this.getEd25519Seed(path));
  }
}

export async function deriveBitcoinLockHdKey(args: {
  walletKeys: Pick<WalletKeys, 'getBitcoinPublicKey'>;
  bitcoinNetwork: BitcoinNetwork;
  vaultId: number;
  hdIndex: number;
}) {
  const { walletKeys, bitcoinNetwork, vaultId, hdIndex } = args;
  const hdPath = bitcoinLockHdPath(vaultId, hdIndex);
  const publicKey = await walletKeys.getBitcoinPublicKey(hdPath, bitcoinNetwork);
  const ownerBitcoinPubkey = getCompressedPubkey(publicKey.publicKey!);
  const address = p2wpkh(ownerBitcoinPubkey, getScureNetwork(bitcoinNetwork)).address;

  return {
    address,
    hdIndex,
    ownerBitcoinPubkey,
    hdPath,
  };
}

export function bitcoinLockHdPath(vaultId: number, hdIndex: number): string {
  return `m/1018'/0'/${vaultId}'/0/${hdIndex}'`;
}

const BITCOIN_VERSIONS = {
  [BitcoinNetwork.Bitcoin]: { private: 0x0488ade4, public: 0x0488b21e },
};
