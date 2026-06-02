import { Accountset, getRange } from '@argonprotocol/apps-core';
import { hexToU8a, Keyring, KeyringPair, KeyringPair$Json, u8aToHex } from '@argonprotocol/mainchain';
import {
  BitcoinNetwork,
  getBip32Version,
  getCompressedPubkey,
  getScureNetwork,
  HDKey,
  p2wpkh,
} from '@argonprotocol/bitcoin';
import type { Hex, Signature } from 'viem';
import ISecurity from '../interfaces/ISecurity.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { IS_TREASURY_APP, NETWORK_NAME } from './Env.ts';
import { WalletType } from './Wallet.ts';

export type EthereumHdPathPrefix = `m/44'/60'/${string}`;

export class WalletKeys {
  public sshPublicKey: string;
  /**
   * Mining address for sidelined storage of funds.
   */
  public miningHoldAddress: string;
  /**
   * Address used for mining bidding, rewards and transaction fees.
   */
  public miningBotAddress: string;
  /**
   * Address registered with mainchain as the vault operator. This account reserves 1 argon as a minimum balance.
   */
  public vaultingAddress: string;

  /**
   * Investment account for liquid locking and external treasury management.
   */
  public investmentAddress: string;
  /**
   * Operational account for ongoing app operations.
   */
  public operationalAddress: string;
  /**
   * Ethereum-compatible address used for EVM/Ethereum integrations tied to this wallet.
   */
  public ethereumAddress: string;
  public ethereumHdPrefixes: ISecurity['ethereumHdPrefixes'];
  public ethereumHdPath: `m/44'/60'/${string}`;
  public councilSignerEthereumHdPath: `m/44'/60'/${string}`;

  public miningBotSubaccountsCache: { [address: string]: { index: number } } = {};
  private upstreamOperatorAuthKeypair?: KeyringPair;

  constructor(
    security: ISecurity,
    public didWalletHavePreviousLife: () => Promise<boolean>,
  ) {
    this.sshPublicKey = security.sshPublicKey;
    this.miningHoldAddress = security.miningHoldAddress;
    this.miningBotAddress = security.miningBotAddress;
    this.vaultingAddress = security.vaultingAddress;
    this.investmentAddress = security.investmentAddress;
    this.operationalAddress = security.operationalAddress;
    this.ethereumAddress = security.ethereumAddress.toLowerCase();
    this.ethereumHdPrefixes = security.ethereumHdPrefixes;
    this.ethereumHdPath = getEthereumHdPath(this.ethereumHdPrefixes.primary);
    this.councilSignerEthereumHdPath = getEthereumHdPath(this.ethereumHdPrefixes.councilSigner);
    if (NETWORK_NAME === 'dev-docker') {
      console.log('WalletKeys initialized with mining address:', this.miningBotAddress);
    }
  }

  public async exposeMasterMnemonic(): Promise<string> {
    return await invokeWithTimeout<string>('expose_mnemonic', {}, 60e3);
  }

  // TODO: move to a refunding proxy account.
  public async exportMiningBotAccountJson(passphrase: string): Promise<KeyringPair$Json> {
    const miningBotAccount = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//mining` }, 60e3);
    const keyring = new Keyring({ type: 'sr25519' }).addFromSeed(miningBotAccount);
    return keyring.toJson(passphrase);
  }

  public async getMiningBotSubaccounts(count = 144): Promise<{ [address: string]: { index: number } }> {
    if (Object.keys(this.miningBotSubaccountsCache).length >= count) {
      return this.miningBotSubaccountsCache;
    }

    const indexes = getRange(0, count);
    for (const index of indexes) {
      const address = Accountset.createMiningSubaccount(this.miningBotAddress, index);
      this.miningBotSubaccountsCache[address] = { index };
    }
    return this.miningBotSubaccountsCache;
  }

  public async getMiningSessionMiniSecret(): Promise<string> {
    const seed = await invokeWithTimeout<Uint8Array>('derive_ed25519_seed', { suri: '//mining//sessions' }, 60e3);
    return u8aToHex(seed);
  }

  // TODO: move signing to backend instead of passing around key
  public async getMiningHoldKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//holding` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  // TODO: move signing to backend instead of passing around key
  public async getVaultingKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//vaulting` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  // TODO: move signing to backend instead of passing around key
  public async getInvestmentKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//investment` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  // TODO: move signing to backend instead of passing around key
  public async getOperationalKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//operational` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  public async getUpstreamOperatorAuthKeypair(): Promise<KeyringPair> {
    if (this.upstreamOperatorAuthKeypair) return this.upstreamOperatorAuthKeypair;

    const account = await invokeWithTimeout<Uint8Array>(
      'derive_sr25519_seed',
      { suri: '//upstream-operator-auth' },
      60e3,
    );
    const keypair = new Keyring({ type: 'sr25519' }).addFromSeed(account);
    this.upstreamOperatorAuthKeypair = keypair;
    return keypair;
  }

  public async getVaultDelegateKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//vaulting//delegate` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  public async getOperationalEncryptionKeypair(): Promise<Uint8Array> {
    return await invokeWithTimeout<Uint8Array>('derive_x25519_public_key', { suri: `//operational//encrypt` }, 60e3);
  }

  public getMintingAuthorityEthereumHdPath(hdIndex: number): `m/44'/60'/${string}` {
    return getEthereumHdPath(this.ethereumHdPrefixes.mintingAuthority, hdIndex);
  }

  public getMintingAuthorityEthereumHdPaths(count: number, startIndex = 0): `m/44'/60'/${string}`[] {
    return Array.from({ length: count }, (_, offset) => this.getMintingAuthorityEthereumHdPath(startIndex + offset));
  }

  public async signEthereumPersonalMessage(
    message: string,
    hdPath?: string,
    format: 'ethereum' | 'argon' = 'ethereum',
  ): Promise<Hex> {
    const signature = await invokeWithTimeout<Hex>(
      'sign_ethereum_personal_message',
      { hdPath: hdPath ?? this.ethereumHdPath, message },
      60e3,
    );
    if (format === 'ethereum') {
      return signature;
    }

    const bytes = hexToU8a(signature);
    if (bytes.length !== 65) {
      throw new Error(`Expected 65-byte ECDSA signature, received ${bytes.length} bytes`);
    }
    if (bytes[64] >= 27) {
      bytes[64] -= 27;
    }
    return u8aToHex(bytes);
  }

  public async getEthereumAddresses(hdPaths: string[]): Promise<string[]> {
    return (await invokeWithTimeout<string[]>('derive_ethereum_addresses', { hdPaths }, 60e3)).map(x =>
      x.toLowerCase(),
    );
  }

  public async signEthereumTransaction(unsignedTransaction: Hex, hdPath = this.ethereumHdPath): Promise<Signature> {
    return await invokeWithTimeout<Signature>(
      'sign_ethereum_transaction',
      { hdPath, request: { unsignedTransaction } },
      60e3,
    );
  }

  public async signEthereumPermit(args: {
    tokenAddress: string;
    tokenName: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  }): Promise<{ v: number; r: string; s: string }> {
    return await invokeWithTimeout<{ v: number; r: string; s: string }>(
      'sign_ethereum_permit',
      {
        hdPath: this.ethereumHdPath,
        request: {
          tokenAddress: args.tokenAddress,
          tokenName: args.tokenName,
          value: args.value.toString(),
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        },
      },
      60e3,
    );
  }

  public async configureEthereumSignerPolicy(args: {
    chainId: number;
    gatewayAddress: string;
    tokenAddresses: string[];
  }): Promise<void> {
    await invokeWithTimeout<void>(
      'set_ethereum_signer_policy',
      {
        request: {
          chainId: args.chainId,
          gatewayAddress: args.gatewayAddress,
          tokenAddresses: args.tokenAddresses,
        },
      },
      60e3,
    );
  }

  // TODO: move signing to backend instead of passing around key
  public async getMiningBotKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//mining` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
  }

  public async getWalletKeypair(walletType: WalletType): Promise<KeyringPair> {
    switch (walletType) {
      case WalletType.miningHold:
        return await this.getMiningHoldKeypair();
      case WalletType.miningBot:
        return await this.getMiningBotKeypair();
      case WalletType.vaulting:
        return await this.getVaultingKeypair();
      case WalletType.operational:
        return await this.getOperationalKeypair();
      case WalletType.investment:
        return await this.getInvestmentKeypair();
      case WalletType.ethereum:
        throw new Error('Ethereum wallets do not have an Argon keypair.');
    }
  }

  public get liquidLockingAddress(): string {
    return IS_TREASURY_APP ? this.investmentAddress : this.vaultingAddress;
  }

  public async getLiquidLockingKeypair(): Promise<KeyringPair> {
    return IS_TREASURY_APP ? this.getInvestmentKeypair() : this.getVaultingKeypair();
  }

  public get treasuryAddress(): string {
    return IS_TREASURY_APP ? this.investmentAddress : this.vaultingAddress;
  }

  public async getTreasuryKeypair(): Promise<KeyringPair> {
    return IS_TREASURY_APP ? this.getInvestmentKeypair() : this.getVaultingKeypair();
  }

  public async getBitcoinChildXpriv(xpubPath: string, network: BitcoinNetwork): Promise<HDKey> {
    const bip32Version = getBip32Version(network) ?? BITCOIN_VERSIONS[network as keyof typeof BITCOIN_VERSIONS];
    if (!bip32Version) {
      throw new Error(`Unsupported Bitcoin network: ${network}`);
    }
    const extendedKey = await invokeWithTimeout<string>(
      'derive_bitcoin_extended_key',
      { hdPath: xpubPath, version: bip32Version.private },
      60e3,
    );
    return HDKey.fromExtendedKey(extendedKey, bip32Version);
  }
}

export async function deriveBitcoinLockHdKey(args: {
  walletKeys: Pick<WalletKeys, 'getBitcoinChildXpriv'>;
  bitcoinNetwork: BitcoinNetwork;
  vaultId: number;
  hdIndex: number;
}) {
  const hdPath = `m/1018'/0'/${args.vaultId}'/0/${args.hdIndex}'`;
  const ownerBitcoinXpriv = await args.walletKeys.getBitcoinChildXpriv(hdPath, args.bitcoinNetwork);
  const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);
  const address = p2wpkh(ownerBitcoinPubkey, getScureNetwork(args.bitcoinNetwork)).address;

  return {
    address,
    hdIndex: args.hdIndex,
    ownerBitcoinPubkey,
    hdPath,
  };
}

const BITCOIN_VERSIONS = {
  [BitcoinNetwork.Bitcoin]: { private: 0x0488ade4, public: 0x0488b21e },
};

export function getEthereumHdPath(prefix: EthereumHdPathPrefix, index = 0): `m/44'/60'/${string}` {
  return `${prefix}/${index}'`;
}
