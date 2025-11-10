import { Accountset, getRange, miniSecretFromUri } from '@argonprotocol/apps-core';
import { Keyring, KeyringPair, KeyringPair$Json } from '@argonprotocol/mainchain';
import { bip39, BitcoinNetwork, getChildXpriv, HDKey } from '@argonprotocol/bitcoin';
import { WalletBalances } from './WalletBalances.ts';
import { getMainchainClients } from '../stores/mainchain.ts';
import ISecurity from '../interfaces/ISecurity.ts';

export class WalletKeys {
  #security: ISecurity;
  #miningAccount: KeyringPair;
  #vaultingAccount: KeyringPair;
  public walletBalances?: WalletBalances;

  public get sshPublicKey(): string {
    return this.#security.sshPublicKey;
  }

  public miningAddress: string;
  public vaultingAddress: string;

  constructor(security: ISecurity) {
    this.#security = security;
    const masterAccount = new Keyring({ type: 'sr25519' }).createFromUri(this.#security.masterMnemonic);
    this.#miningAccount = masterAccount.derive(`//mining`);
    this.#vaultingAccount = masterAccount.derive(`//vaulting`);
    this.miningAddress = this.#miningAccount.address;
    this.vaultingAddress = this.#vaultingAccount.address;
  }

  public async exposeMasterMnemonic(): Promise<string> {
    return this.#security.masterMnemonic;
  }

  public getBalances(): WalletBalances {
    this.walletBalances ??= new WalletBalances(getMainchainClients(), this);
    return this.walletBalances;
  }

  public async didWalletHavePreviousLife() {
    const walletBalances = this.getBalances();
    await walletBalances.load();
    return walletBalances.didWalletHavePreviousLife();
  }

  public async exportMiningAccountJson(passphrase: string): Promise<KeyringPair$Json> {
    return this.#miningAccount.toJson(passphrase);
  }

  public async getMiningSubaccounts(count = 144): Promise<{ [address: string]: { index: number } }> {
    return Accountset.getSubaccounts(this.#miningAccount, getRange(0, count));
  }

  public async getMiningSessionMiniSecret(): Promise<string> {
    return miniSecretFromUri(`${this.#security.masterMnemonic}//mining//sessions`);
  }

  public async getVaultingKeypair(): Promise<KeyringPair> {
    return this.#vaultingAccount;
  }

  public async getBitcoinChildXpriv(xpubPath: string, network: BitcoinNetwork): Promise<HDKey> {
    const masterXprivSeed = await bip39.mnemonicToSeed(this.#security.masterMnemonic);
    return getChildXpriv(masterXprivSeed, xpubPath, network);
  }
}
