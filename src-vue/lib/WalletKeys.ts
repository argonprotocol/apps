import { Accountset, getRange } from '@argonprotocol/apps-core';
import { Keyring, KeyringPair, KeyringPair$Json, u8aToHex } from '@argonprotocol/mainchain';
import { BitcoinNetwork, getBip32Version, HDKey } from '@argonprotocol/bitcoin';
import ISecurity from '../interfaces/ISecurity.ts';
import { invokeWithTimeout } from './tauriApi.ts';

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

  public miningBotSubaccountsCache: { [address: string]: { index: number } } = {};

  constructor(
    security: ISecurity,
    public didWalletHavePreviousLife: () => Promise<boolean>,
  ) {
    this.sshPublicKey = security.sshPublicKey;
    this.miningHoldAddress = security.miningHoldAddress;
    this.miningBotAddress = security.miningBotAddress;
    this.vaultingAddress = security.vaultingAddress;
    console.log('WalletKeys initialized with mining address:', this.miningBotAddress, security);
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
    // TODO: can remove 10 days after deploying new formats (as of 11/19/2025)
    const includeDeprecatedAddressDerivation = true;
    const derivedAddresses = includeDeprecatedAddressDerivation
      ? await invokeWithTimeout<string[]>('derive_sr25519_address', { suris: indexes.map(i => `//mining//${i}`) }, 60e3)
      : undefined;
    for (const index of indexes) {
      if (derivedAddresses) {
        const deprecatedAddress = derivedAddresses[index];
        this.miningBotSubaccountsCache[deprecatedAddress] = { index };
      }
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
  public async getMiningBotKeypair(): Promise<KeyringPair> {
    const account = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//mining` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(account);
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

const BITCOIN_VERSIONS = {
  [BitcoinNetwork.Bitcoin]: { private: 0x0488ade4, public: 0x0488b21e },
};
