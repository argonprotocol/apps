import { MainchainClients } from '@argonprotocol/apps-core';
import { FrameSystemAccountInfo, PalletBalancesAccountData } from '@argonprotocol/mainchain';
import { createDeferred } from './Utils';
import { WalletKeys } from './WalletKeys.ts';

export interface IWallet {
  address: string;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
}

export class WalletBalances {
  private clients: MainchainClients;
  private subscriptions: VoidFunction[] = [];
  private deferredLoading = createDeferred<void>(false);
  private readonly walletKeys: WalletKeys;

  public onBalanceChange?: () => void;

  public miningWallet: IWallet = {
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  };

  public vaultingWallet: IWallet = {
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  };

  public totalWalletMicrogons: bigint = 0n;
  public totalWalletMicronots: bigint = 0n;

  constructor(mainchainClients: MainchainClients, walletKeys: WalletKeys) {
    this.clients = mainchainClients;
    this.walletKeys = walletKeys;
  }

  public async load() {
    if (this.deferredLoading.isRunning || this.deferredLoading.isSettled) {
      return this.deferredLoading.promise;
    }
    this.deferredLoading.setIsRunning(true);

    const { miningAddress, vaultingAddress } = this.walletKeys;
    this.miningWallet.address = miningAddress;
    this.vaultingWallet.address = vaultingAddress;

    await this.updateBalances(false);
    this.deferredLoading.resolve();
  }

  public async updateBalances(waitForLoad = true) {
    if (waitForLoad) await this.deferredLoading.promise;

    for (const wallet of [this.miningWallet, this.vaultingWallet]) {
      await Promise.all([this.loadMicrogonBalance(wallet), this.loadMicronotBalance(wallet)]);
    }

    this.onBalanceChange?.();
  }

  public async subscribeToBalanceUpdates() {
    await this.deferredLoading.promise;

    if (this.subscriptions.length) {
      this.subscriptions.forEach(x => x());
      this.subscriptions.length = 0;
    }

    for (const wallet of [this.miningWallet, this.vaultingWallet]) {
      const client = await this.clients.prunedClientOrArchivePromise;
      const [subMicrogon, subMicronot] = await Promise.all([
        client.query.system.account(wallet.address, result => {
          this.handleMicrogonBalanceChange(result, wallet);
        }),
        client.query.ownership.account(wallet.address, result => {
          this.handleMicronotBalanceChange(result, wallet);
        }),
      ]);
      this.subscriptions.push(subMicrogon, subMicronot);
    }
  }

  public async didWalletHavePreviousLife() {
    const hasVaultHistory = WalletBalances.doesWalletHaveValue(this.vaultingWallet);
    const hasMiningHistory = WalletBalances.doesWalletHaveValue(this.miningWallet);
    return hasVaultHistory || hasMiningHistory;
  }

  private async loadMicrogonBalance(wallet: IWallet) {
    const client = await this.clients.prunedClientOrArchivePromise;
    const result = await client.query.system.account(wallet.address);
    this.handleMicrogonBalanceChange(result, wallet);
  }

  private async loadMicronotBalance(wallet: IWallet) {
    const client = await this.clients.prunedClientOrArchivePromise;
    const result = await client.query.ownership.account(wallet.address);
    this.handleMicronotBalanceChange(result, wallet);
  }

  private handleMicrogonBalanceChange(result: FrameSystemAccountInfo, wallet: IWallet) {
    const availableMicrogons = result.data.free.toBigInt();
    const reservedMicrogons = result.data.reserved.toBigInt();
    const availableMicrogonsDiff = availableMicrogons + reservedMicrogons - wallet.availableMicrogons;

    wallet.availableMicrogons = availableMicrogons;
    wallet.reservedMicrogons = reservedMicrogons;

    this.totalWalletMicrogons += availableMicrogonsDiff;
    this.onBalanceChange?.();
  }

  private handleMicronotBalanceChange(result: PalletBalancesAccountData, wallet: IWallet) {
    const availableMicronots = result.free.toBigInt();
    const reservedMicronots = result.reserved.toBigInt();
    const micronotsDiff = availableMicronots + reservedMicronots - wallet.availableMicronots;

    wallet.availableMicronots = availableMicronots;
    wallet.reservedMicronots = reservedMicronots;

    this.totalWalletMicronots += micronotsDiff;
    this.onBalanceChange?.();
  }

  public static doesWalletHaveValue(wallet: IWallet): boolean {
    if (wallet.availableMicrogons > 0n) return true;
    if (wallet.availableMicronots > 0n) return true;
    if (wallet.reservedMicronots > 0n) return true;
    if (wallet.reservedMicrogons > 0n) return true;
    return false;
  }
}
