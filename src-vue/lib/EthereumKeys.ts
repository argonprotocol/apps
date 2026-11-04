import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import {
  bytesToHex,
  getAddress,
  keccak256,
  parseSignature,
  parseTransaction,
  serializeTransaction,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type Signature,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, sign } from 'viem/accounts';
import { WalletSecrets } from './WalletSecrets.ts';

export type EthereumHdPathPrefix = `m/44'/60'/${string}`;
export const ETHEREUM_HD_PREFIXES = {
  primary: `m/44'/60'/0'/0'`,
  councilSigner: `m/44'/60'/1'/0'`,
  mintingAuthority: `m/44'/60'/2'/0'`,
} as const;

type EthereumSignerPolicy = {
  chainId: number;
  gatewayAddress: Address;
  tokenAddresses: ReadonlySet<string>;
};

export class EthereumKeys {
  private policy?: EthereumSignerPolicy;

  constructor(private readonly secrets?: WalletSecrets) {}

  public createSigner(privateKey: Hex): EthereumSigner {
    return new EthereumSigner(privateKey, () => this.policy);
  }

  public async configureEthereumSignerPolicy(args: {
    chainId: number;
    gatewayAddress: string;
    tokenAddresses: string[];
  }): Promise<void> {
    const { chainId, gatewayAddress, tokenAddresses } = args;
    if (!Number.isSafeInteger(chainId) || chainId < 0)
      throw new Error('Ethereum chain ID must be a nonnegative safe integer');
    this.policy = {
      chainId,
      gatewayAddress: normalizeEthereumAddress(gatewayAddress),
      tokenAddresses: new Set(tokenAddresses.map(address => normalizeEthereumAddress(address).toLowerCase())),
    };
  }

  public static accountFromMnemonic(mnemonic: string, path: string) {
    if (!path.startsWith("m/44'/60'/")) throw new Error("Ethereum derivations must use an m/44'/60'/... path");
    return mnemonicToAccount(mnemonic, { path: path as EthereumHdPathPrefix });
  }

  public static parsePrivateKey(value: string): { privateKey: Hex; address: Address } {
    const key = value.trim();
    const privateKey = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
    return { privateKey, address: privateKeyToAccount(privateKey).address };
  }

  public static previewMnemonic(mnemonic: string, count = 10): { derivationPath: string; address: string }[] {
    return Array.from({ length: count }, (_, index) => {
      const derivationPath = `m/44'/60'/0'/0/${index}`;
      return { derivationPath, address: EthereumKeys.accountFromMnemonic(mnemonic, derivationPath).address };
    });
  }

  public async getPrivateKey(hdPath = getEthereumHdPath(ETHEREUM_HD_PREFIXES.primary)): Promise<Hex> {
    assertEthereumHdPath(hdPath);
    const mnemonic = await this.requireSecrets().getMnemonic();
    const key = EthereumKeys.accountFromMnemonic(mnemonic, hdPath).getHdKey().privateKey;
    if (!key) throw new Error('Unable to derive the Ethereum private key.');
    return bytesToHex(key);
  }

  private requireSecrets(): WalletSecrets {
    if (!this.secrets) throw new Error('No wallet secret source is loaded.');
    return this.secrets;
  }
}

export class EthereumSigner {
  public readonly address: Address;
  #privateKey?: Hex;
  readonly #getPolicy: () => EthereumSignerPolicy | undefined;

  constructor(privateKey: Hex, getPolicy: () => EthereumSignerPolicy | undefined) {
    this.address = privateKeyToAccount(privateKey).address;
    this.#privateKey = privateKey;
    this.#getPolicy = getPolicy;
    Object.freeze(this);
  }

  public readonly signMessage: PrivateKeyAccount['signMessage'] = async parameters => {
    const privateKey = this.requireKey();
    const signature = await privateKeyToAccount(privateKey).signMessage(parameters);
    this.requireKey();
    return signature;
  };

  public async signEthereumTransaction(unsignedTransaction: Hex): Promise<Signature> {
    const privateKey = this.requireKey();
    const policy = this.#getPolicy();
    if (!policy) throw new Error('Ethereum signer policy has not been configured yet');
    const transaction = parseTransaction(unsignedTransaction);
    if (transaction.type !== 'eip1559') throw new Error('Ethereum signer only supports unsigned EIP-1559 transactions');
    if (transaction.r || transaction.s || transaction.yParity !== undefined)
      throw new Error('Ethereum signer only supports unsigned transactions');
    if (serializeTransaction(transaction).toLowerCase() !== unsignedTransaction.toLowerCase())
      throw new Error('Unsigned Ethereum transaction is not canonical or has trailing bytes');
    if (transaction.chainId !== policy.chainId)
      throw new Error('Ethereum transaction chain ID does not match the configured signer policy');
    const signature = await sign({ privateKey, hash: keccak256(unsignedTransaction) });
    this.requireKey();
    return signature;
  }

  public async signEthereumPermit(args: {
    tokenAddress: string;
    tokenName: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  }): Promise<{ v: number; r: string; s: string }> {
    const { tokenAddress, tokenName, value, nonce, deadline } = args;
    const privateKey = this.requireKey();
    const policy = this.#getPolicy();
    if (!policy) throw new Error('Ethereum signer policy has not been configured yet');
    const token = normalizeEthereumAddress(tokenAddress);
    if (!policy.tokenAddresses.has(token.toLowerCase())) throw new Error('Ethereum permit token is not allowed');
    const account = privateKeyToAccount(privateKey);
    const signature = parseSignature(
      await account.signTypedData({
        domain: { name: tokenName, version: '1', chainId: policy.chainId, verifyingContract: token },
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
        message: { owner: account.address, spender: policy.gatewayAddress, value, nonce, deadline },
      }),
    );
    this.requireKey();
    return { v: Number(signature.v), r: signature.r, s: signature.s };
  }

  public close(): void {
    this.#privateKey = undefined;
  }

  private requireKey(): Hex {
    if (!this.#privateKey) throw new Error('Signing access has ended');
    return this.#privateKey;
  }
}

export function getEthereumHdPath(prefix: EthereumHdPathPrefix, index = 0): `m/44'/60'/${string}` {
  return `${prefix}/${index}'`;
}

export function toArgonEthereumSignature(signature: Hex): Hex {
  const bytes = hexToU8a(signature);
  if (bytes.length !== 65) {
    throw new Error(`Expected 65-byte ECDSA signature, received ${bytes.length} bytes`);
  }
  if (bytes[64] >= 27) bytes[64] -= 27;
  return u8aToHex(bytes);
}

export function assertEthereumHdPath(path: string): asserts path is `m/44'/60'/${string}` {
  if (!path.startsWith("m/44'/60'/")) throw new Error("Ethereum derivations must use an m/44'/60'/... path");
  const suffix = path.slice("m/44'/60'/".length);
  if (!suffix || !suffix.split('/').every(segment => /^\d+'$/.test(segment))) {
    throw new Error("Ethereum custom derivations must use hardened segments after m/44'/60'/");
  }
}

function normalizeEthereumAddress(value: string): Address {
  const address = value.trim();
  return getAddress(address.startsWith('0x') ? address : `0x${address}`);
}
