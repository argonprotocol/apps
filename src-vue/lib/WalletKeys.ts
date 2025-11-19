import { Accountset, getRange } from '@argonprotocol/apps-core';
import { Keyring, KeyringPair, KeyringPair$Json, u8aToHex } from '@argonprotocol/mainchain';
import { BitcoinNetwork, getBip32Version, HDKey } from '@argonprotocol/bitcoin';
import { WalletBalances } from './WalletBalances.ts';
import { getMainchainClients } from '../stores/mainchain.ts';
import ISecurity from '../interfaces/ISecurity.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';

export class WalletKeys {
  public walletBalances?: WalletBalances;

  public sshPublicKey: string;
  /**
   * Address used for mining bidding, rewards and transaction fees.
   */
  public miningAddress: string;
  /**
   * Address registered with mainchain as the vault operator. This account reserves 1 argon as a minimum balance.
   */
  public vaultingAddress: string;
  /**
   * Holding address for long-term storage of funds.
   */
  public holdingAddress: string;

  public miningSubaccountsCache: { [address: string]: { index: number } } = {};

  constructor(security: ISecurity) {
    this.sshPublicKey = security.sshPublicKey;
    this.miningAddress = security.miningAddress;
    this.vaultingAddress = security.vaultingAddress;
    this.holdingAddress = security.holdingAddress;
    console.log('WalletKeys initialized with mining address:', this.miningAddress, security);
  }

  public async exposeMasterMnemonic(): Promise<string> {
    return await invokeWithTimeout<string>('expose_mnemonic', {}, 60e3);
  }

  public getBalances(): WalletBalances {
    this.walletBalances ??= new WalletBalances(getMainchainClients(), this, getDbPromise());
    return this.walletBalances;
  }

  public async didWalletHavePreviousLife() {
    const walletBalances = this.getBalances();
    await walletBalances.load();
    return walletBalances.didWalletHavePreviousLife();
  }

  // TODO: move to a refunding proxy account.
  public async exportMiningAccountJson(passphrase: string): Promise<KeyringPair$Json> {
    const miningAccount = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//mining` }, 60e3);
    const keyring = new Keyring({ type: 'sr25519' }).addFromSeed(miningAccount);
    return keyring.toJson(passphrase);
  }

  public async getMiningSubaccounts(count = 144): Promise<{ [address: string]: { index: number } }> {
    if (Object.keys(this.miningSubaccountsCache).length >= count) {
      return this.miningSubaccountsCache;
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
        this.miningSubaccountsCache[deprecatedAddress] = { index };
      }
      const address = Accountset.createMiningSubaccount(this.miningAddress, index);
      this.miningSubaccountsCache[address] = { index };
    }
    return this.miningSubaccountsCache;
  }

  public async getMiningSessionMiniSecret(): Promise<string> {
    const seed = await invokeWithTimeout<Uint8Array>('derive_ed25519_seed', { suri: '//mining//sessions' }, 60e3);
    return u8aToHex(seed);
  }

  // TODO: move signing to backend instead of passing around key
  public async getHoldingKeypair(): Promise<KeyringPair> {
    const holdingAccount = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//holding` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(holdingAccount);
  }

  // TODO: move signing to backend instead of passing around key
  public async getVaultingKeypair(): Promise<KeyringPair> {
    const miningAccount = await invokeWithTimeout<Uint8Array>('derive_sr25519_seed', { suri: `//vaulting` }, 60e3);
    return new Keyring({ type: 'sr25519' }).addFromSeed(miningAccount);
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
