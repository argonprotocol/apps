import * as Vue from 'vue';
import type { Currency } from './Currency.ts';
import type { Db } from './Db.ts';
import { WalletForEthereum } from './WalletForEthereum.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { IWalletRecord } from './db/WalletsTable.ts';
import { restoreCachedExternalWalletBalances, type FinancialCacheTable } from './db/FinancialCacheTable.ts';
import { invokeWithTimeout } from './tauriApi.ts';

const DEFAULT_ETHEREUM_HD_PATH = "m/44'/60'/0'/0'/0'";

export class WalletsForEthereum {
  public readonly coreWallet: Vue.Raw<WalletForEthereum>;
  public readonly persistedWallets = Vue.shallowReactive<Vue.Raw<WalletForEthereum>[]>([]);

  private readonly walletsByRecordId = new Map<number, Vue.Raw<WalletForEthereum>>();
  private recordsAreLoaded = false;
  private recordsLoadPromise?: Promise<void>;

  constructor(
    private readonly walletKeys: Pick<WalletKeys, 'coreEthereumAddress' | 'isCoreEthereumWallet'>,
    private readonly dbPromise: Promise<Db>,
    private readonly financialCache: Promise<FinancialCacheTable>,
  ) {
    this.coreWallet = this.createWallet(walletKeys.coreEthereumAddress, undefined, true);
  }

  public get length(): number {
    return this.persistedWallets.length;
  }

  public get(recordId: number): WalletForEthereum {
    const wallet = this.find(recordId);
    if (!wallet) throw new Error(`Ethereum wallet not found: ${recordId}`);
    return wallet;
  }

  public find(recordId: number): WalletForEthereum | undefined {
    return this.walletsByRecordId.get(recordId);
  }

  public findByAddress(address: string): WalletForEthereum | undefined {
    const normalizedAddress = address.toLowerCase();
    if (normalizedAddress === this.coreWallet.address.toLowerCase()) return this.coreWallet;
    return this.persistedWallets.find(wallet => wallet.address.toLowerCase() === normalizedAddress);
  }

  public async resolve(address: string): Promise<WalletForEthereum | undefined> {
    if (!this.recordsAreLoaded) await this.reloadRecords();
    return this.findByAddress(address);
  }

  public createFinancialPositions(currency: Currency) {
    return this.persistedWallets.flatMap(wallet => wallet.createFinancialPositions(currency));
  }

  public async loadCachedBalances(): Promise<void> {
    await this.reloadRecords();
    await Promise.all(
      this.persistedWallets.map(wallet =>
        restoreCachedExternalWalletBalances(this.financialCache, 'ethereum', wallet.data),
      ),
    );
  }

  public async load(): Promise<void> {
    await this.loadCachedBalances();

    let inspectedCoreWallet = false;
    if (!this.coreWallet.isPersisted) {
      inspectedCoreWallet = true;
      await this.coreWallet.load({ startRefresh: false }).catch(error => {
        console.warn('Unable to inspect the core Ethereum wallet during wallet seeding', error);
      });
      if (this.coreWalletHasValue()) {
        const db = await this.dbPromise;
        await db.walletsTable.createDefaultEthereum({
          address: this.walletKeys.coreEthereumAddress,
          derivationPath: DEFAULT_ETHEREUM_HD_PATH,
        });
        await this.reloadRecords(true);
      }
    }

    await Promise.all(
      this.persistedWallets.map(wallet =>
        wallet === this.coreWallet && inspectedCoreWallet ? wallet.load({ force: false }) : wallet.load(),
      ),
    );
  }

  public async importPrivateKey(args: { name: string; privateKey: string }): Promise<WalletForEthereum> {
    const [address, encryptedSecret] = await Promise.all([
      invokeWithTimeout<string>(
        'derive_external_ethereum_address_from_private_key',
        { privateKey: args.privateKey },
        60e3,
      ),
      invokeWithTimeout<string>('encrypt_wallet_secret', { secret: args.privateKey }, 60e3),
    ]);
    const db = await this.dbPromise;
    const record = await db.walletsTable.importExternalEthereum({
      name: args.name,
      address,
      coreEthereumAddress: this.walletKeys.coreEthereumAddress,
      secretKind: 'privateKey',
      encryptedSecret,
    });
    await this.reloadRecords(true);
    return this.get(record.id);
  }

  public async importMnemonic(args: {
    name: string;
    mnemonic: string;
    address: string;
    derivationPath: string;
  }): Promise<WalletForEthereum> {
    const encryptedSecret = await invokeWithTimeout<string>('encrypt_wallet_secret', { secret: args.mnemonic }, 60e3);
    const db = await this.dbPromise;
    const record = await db.walletsTable.importExternalEthereum({
      name: args.name,
      address: args.address,
      coreEthereumAddress: this.walletKeys.coreEthereumAddress,
      derivationPath: args.derivationPath,
      secretKind: 'mnemonic',
      encryptedSecret,
    });
    await this.reloadRecords(true);
    return this.get(record.id);
  }

  public async disconnect(wallet: WalletForEthereum): Promise<void> {
    const record = wallet.record;
    if (!record || this.walletsByRecordId.get(record.id) !== wallet) {
      throw new Error('Ethereum wallet is not connected.');
    }

    if (wallet.isCore) {
      await wallet.refresh();
      if (wallet.data.fetchErrorMsg) {
        throw new Error('Unable to verify that the Default Ethereum wallet is empty. Please try again.');
      }
      if (walletHasValue(wallet)) {
        throw new Error('The Default Ethereum wallet must be empty before it can be disconnected.');
      }
    }

    const db = await this.dbPromise;
    await db.financialCacheTable.deleteExternalWalletBalance('ethereum', wallet.address);
    await db.walletsTable.deleteEthereumWallet(record.id);
    await this.reloadRecords(true);
  }

  public dispose(): void {
    this.coreWallet.dispose();
    for (const wallet of this.persistedWallets) {
      if (wallet !== this.coreWallet) wallet.dispose();
    }
    this.walletsByRecordId.clear();
    this.persistedWallets.length = 0;
  }

  private async reloadRecords(force = false): Promise<void> {
    if (this.recordsLoadPromise) {
      await this.recordsLoadPromise;
      if (!force) return;
    }
    this.recordsLoadPromise = (async () => {
      const db = await this.dbPromise;
      this.reconcile(await db.walletsTable.fetchEthereumWallets());
      this.recordsAreLoaded = true;
    })();
    try {
      await this.recordsLoadPromise;
    } finally {
      this.recordsLoadPromise = undefined;
    }
  }

  private reconcile(records: IWalletRecord[]): void {
    const nextWalletsByRecordId = new Map<number, WalletForEthereum>();
    const nextPersistedWallets: WalletForEthereum[] = [];

    for (const record of records) {
      if (record.walletType !== 'ethereum') continue;
      const isCore = this.walletKeys.isCoreEthereumWallet(record);
      const existingWallet = isCore ? this.coreWallet : this.walletsByRecordId.get(record.id);
      const wallet =
        existingWallet?.address.toLowerCase() === record.address.toLowerCase()
          ? existingWallet
          : this.createWallet(record.address, record, isCore);
      nextWalletsByRecordId.set(record.id, wallet);
      nextPersistedWallets.push(wallet);
    }

    const coreRecord = records.find(record => this.walletKeys.isCoreEthereumWallet(record));
    this.coreWallet.setRecord(coreRecord);
    for (const wallet of nextPersistedWallets) {
      const record = records.find(candidate => candidate.id === wallet.id);
      if (record) wallet.setRecord(record);
    }

    for (const [recordId, wallet] of this.walletsByRecordId) {
      if (nextWalletsByRecordId.get(recordId) !== wallet && wallet !== this.coreWallet) wallet.dispose();
    }

    this.walletsByRecordId.clear();
    for (const [recordId, wallet] of nextWalletsByRecordId) this.walletsByRecordId.set(recordId, wallet);
    this.persistedWallets.splice(0, this.persistedWallets.length, ...nextPersistedWallets);
  }

  private createWallet(address: string, record?: IWalletRecord, isCore = false): Vue.Raw<WalletForEthereum> {
    const wallet = new WalletForEthereum(address, this.financialCache, record, isCore);
    wallet.data = Vue.reactive(wallet.data);
    return Vue.markRaw(wallet);
  }

  private coreWalletHasValue(): boolean {
    return walletHasValue(this.coreWallet);
  }
}

function walletHasValue(wallet: WalletForEthereum): boolean {
  return (
    wallet.data.availableMicrogons > 0n ||
    wallet.data.reservedMicrogons > 0n ||
    wallet.data.availableMicronots > 0n ||
    wallet.data.reservedMicronots > 0n ||
    wallet.data.otherTokens.some(token => token.value > 0n)
  );
}
