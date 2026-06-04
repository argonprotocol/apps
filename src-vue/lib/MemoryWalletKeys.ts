import { miniSecretFromUri } from '@argonprotocol/apps-core';
import { hexToU8a, Keyring, type KeyringPair, type KeyringPair$Json, u8aToHex } from '@argonprotocol/mainchain';
import { bip39, BitcoinNetwork, getBip32Version, HDKey } from '@argonprotocol/bitcoin';
import { x25519 } from '@noble/curves/ed25519';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex, parseSignature, parseTransaction, type Address, type Hex, type Signature } from 'viem';
import type ISecurity from '../interfaces/ISecurity.ts';
import { getEthereumHdPath, WalletKeys } from './WalletKeys.ts';

export const DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES = {
  primary: `m/44'/60'/0'/0'`,
  councilSigner: `m/44'/60'/1'/0'`,
  mintingAuthority: `m/44'/60'/2'/0'`,
} as const satisfies ISecurity['ethereumHdPrefixes'];

export class MemoryWalletKeys extends WalletKeys {
  private readonly substrateSuri: string;
  private readonly masterMnemonic: string;
  private readonly miningHoldAccount: KeyringPair;
  private readonly miningBotAccount: KeyringPair;
  private readonly vaultingAccount: KeyringPair;
  private readonly investmentAccount: KeyringPair;
  private readonly operationalAccount: KeyringPair;
  private readonly vaultDelegateAccount: KeyringPair;
  private readonly upstreamOperatorAuthAccount: KeyringPair;
  private ethereumSignerPolicy?:
    | {
        chainId: number;
        gatewayAddress: string;
        tokenAddresses: string[];
      }
    | undefined;

  constructor(args: {
    substrateSuri: string;
    masterMnemonic: string;
    didWalletHavePreviousLife?: () => Promise<boolean>;
    ethereumHdPrefixes?: ISecurity['ethereumHdPrefixes'];
    sshPublicKey?: string;
  }) {
    const rootAccount = new Keyring({ type: 'sr25519' }).addFromUri(args.substrateSuri);
    const miningHoldAccount = rootAccount.derive('//holding');
    const miningBotAccount = rootAccount.derive('//mining');
    const vaultingAccount = rootAccount.derive('//vaulting');
    const investmentAccount = rootAccount.derive('//investment');
    const operationalAccount = rootAccount.derive('//operational');
    const ethereumHdPrefixes = args.ethereumHdPrefixes ?? DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES;
    const ethereumAccount = mnemonicToAccount(args.masterMnemonic, {
      path: getEthereumHdPath(ethereumHdPrefixes.primary),
    });

    super(
      {
        sshPublicKey: args.sshPublicKey ?? '',
        miningHoldAddress: miningHoldAccount.address,
        miningBotAddress: miningBotAccount.address,
        vaultingAddress: vaultingAccount.address,
        investmentAddress: investmentAccount.address,
        operationalAddress: operationalAccount.address,
        ethereumAddress: ethereumAccount.address,
        ethereumHdPrefixes,
      },
      args.didWalletHavePreviousLife ?? (() => Promise.resolve(false)),
    );

    this.substrateSuri = args.substrateSuri;
    this.masterMnemonic = args.masterMnemonic;
    this.miningHoldAccount = miningHoldAccount;
    this.miningBotAccount = miningBotAccount;
    this.vaultingAccount = vaultingAccount;
    this.investmentAccount = investmentAccount;
    this.operationalAccount = operationalAccount;
    this.vaultDelegateAccount = vaultingAccount.derive('//delegate');
    this.upstreamOperatorAuthAccount = operationalAccount.derive('//upstream-operator-auth');
  }

  public async exposeMasterMnemonic(): Promise<string> {
    return this.masterMnemonic;
  }

  public async exportEthereumPrivateKey(): Promise<Hex> {
    const privateKey = this.getEthereumAccount().getHdKey().privateKey;
    if (!privateKey) {
      throw new Error('Unable to derive the Ethereum private key.');
    }
    return bytesToHex(privateKey);
  }

  public async exportMiningBotAccountJson(passphrase: string): Promise<KeyringPair$Json> {
    return this.miningBotAccount.toJson(passphrase);
  }

  public async getMiningSessionMiniSecret(): Promise<string> {
    return miniSecretFromUri(`${this.substrateSuri}//mining//session`);
  }

  public async getMiningHoldKeypair(): Promise<KeyringPair> {
    return this.miningHoldAccount;
  }

  public async getVaultingKeypair(): Promise<KeyringPair> {
    return this.vaultingAccount;
  }

  public async getInvestmentKeypair(): Promise<KeyringPair> {
    return this.investmentAccount;
  }

  public async getOperationalKeypair(): Promise<KeyringPair> {
    return this.operationalAccount;
  }

  public async getUpstreamOperatorAuthKeypair(): Promise<KeyringPair> {
    return this.upstreamOperatorAuthAccount;
  }

  public async getVaultDelegateKeypair(): Promise<KeyringPair> {
    return this.vaultDelegateAccount;
  }

  public async getOperationalEncryptionKeypair(): Promise<Uint8Array> {
    return x25519.getPublicKey(hexToU8a(miniSecretFromUri(`${this.substrateSuri}//operational//encrypt`)));
  }

  public async getMiningBotKeypair(): Promise<KeyringPair> {
    return this.miningBotAccount;
  }

  public async signEthereumPersonalMessage(
    message: string,
    hdPath?: string,
    format: 'ethereum' | 'argon' = 'ethereum',
  ): Promise<Hex> {
    const signature = await this.getEthereumAccount(hdPath).signMessage({
      message: { raw: message as Hex },
    });
    if (format === 'ethereum') {
      return signature;
    }

    const bytes = hexToU8a(signature);
    if (bytes[64] >= 27) {
      bytes[64] -= 27;
    }
    return u8aToHex(bytes);
  }

  public async getEthereumAddresses(hdPaths: string[]): Promise<string[]> {
    return hdPaths.map(path =>
      mnemonicToAccount(this.masterMnemonic, {
        path: path as `m/44'/60'/${string}`,
      }).address.toLowerCase(),
    );
  }

  public async signEthereumTransaction(unsignedTransaction: Hex, hdPath = this.ethereumHdPath): Promise<Signature> {
    const signedTransaction = await this.getEthereumAccount(hdPath).signTransaction(
      parseTransaction(unsignedTransaction),
    );
    const signature = parseTransaction(signedTransaction);

    return {
      r: signature.r!,
      s: signature.s!,
      v: signature.v!,
    };
  }

  public async signEthereumPermit(args: {
    tokenAddress: string;
    tokenName: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  }): Promise<{ v: number; r: string; s: string }> {
    if (!this.ethereumSignerPolicy) {
      throw new Error('Ethereum signer policy must be configured before signing permits.');
    }
    if (!this.ethereumSignerPolicy.tokenAddresses.includes(args.tokenAddress)) {
      throw new Error(`Token ${args.tokenAddress} is not allowed by the Ethereum signer policy.`);
    }

    const signature = parseSignature(
      await this.getEthereumAccount().signTypedData({
        domain: {
          name: args.tokenName,
          version: '1',
          chainId: this.ethereumSignerPolicy.chainId,
          verifyingContract: args.tokenAddress as Address,
        },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner: this.ethereumAddress as Address,
          spender: this.ethereumSignerPolicy.gatewayAddress as Address,
          value: args.value,
          nonce: args.nonce,
          deadline: args.deadline,
        },
      }),
    );

    return {
      v: Number(signature.v),
      r: signature.r,
      s: signature.s,
    };
  }

  public async configureEthereumSignerPolicy(args: {
    chainId: number;
    gatewayAddress: string;
    tokenAddresses: string[];
  }): Promise<void> {
    this.ethereumSignerPolicy = args;
  }

  public async getBitcoinChildXpriv(xpubPath: string, network: BitcoinNetwork): Promise<HDKey> {
    const version = getBip32Version(network) ?? BITCOIN_VERSIONS[network as keyof typeof BITCOIN_VERSIONS];
    const seed = await bip39.mnemonicToSeed(this.masterMnemonic);
    return HDKey.fromMasterSeed(seed, version).derive(xpubPath);
  }

  private getEthereumAccount(hdPath?: string) {
    return mnemonicToAccount(this.masterMnemonic, {
      path: (hdPath ?? this.ethereumHdPath) as `m/44'/60'/${string}`,
    });
  }
}

const BITCOIN_VERSIONS = {
  [BitcoinNetwork.Bitcoin]: { private: 0x0488ade4, public: 0x0488b21e },
};
