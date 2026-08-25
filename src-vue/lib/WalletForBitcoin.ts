import type { Vault } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockProcessingDetails } from '../interfaces/IBitcoinLockSummary.ts';
import BitcoinLocks from './BitcoinLocks.ts';
import { WalletForChain, WalletType } from './Wallet.ts';

export class WalletForBitcoin extends WalletForChain<WalletType.bitcoin> {
  private readonly channelCreationsByVaultId = Vue.reactive(new Map<number, Promise<IBitcoinLockRecord>>());

  constructor(
    private readonly getBitcoinLocks: () => BitcoinLocks,
    private readonly getLockOwner: () => string,
    address = '',
  ) {
    super({ address, type: WalletType.bitcoin });
  }

  public async loadChannels(): Promise<void> {
    await this.getBitcoinLocks().load();
  }

  public getChannel(uuid: string): IBitcoinLockRecord | undefined {
    return this.getBitcoinLocks()
      .getAllLocks()
      .find(lock => lock.uuid === uuid);
  }

  public getLatestActiveChannel(vaultId: number): IBitcoinLockRecord | undefined {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks.getAllLocks().find(lock => {
      if (lock.vaultId !== vaultId) return false;
      if (lock.status === BitcoinLockStatus.LockIsProcessingOnArgon) return true;
      return (
        lock.status === BitcoinLockStatus.LockPendingFunding &&
        !bitcoinLocks.hasObservedFundingSignal(lock) &&
        !bitcoinLocks.isFundingWindowExpired(lock)
      );
    });
  }

  public getLatestFundedUnexpiredChannel(vaultId: number): IBitcoinLockRecord | undefined {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks.getAllLocks().find(lock => {
      return (
        lock.vaultId === vaultId &&
        lock.status === BitcoinLockStatus.LockPendingFunding &&
        bitcoinLocks.hasObservedFundingSignal(lock) &&
        !bitcoinLocks.isFundingWindowExpired(lock)
      );
    });
  }

  public getChannelProgress(lock: IBitcoinLockRecord): IBitcoinLockProcessingDetails {
    return this.getBitcoinLocks().getLockProcessingDetails(lock);
  }

  public getChannelError(lock: IBitcoinLockRecord): string {
    return this.getBitcoinLocks().getLockProcessingError(lock);
  }

  public hasObservedChannelFunding(lock: IBitcoinLockRecord): boolean {
    return this.getBitcoinLocks().hasObservedFundingSignal(lock);
  }

  public getChannelFundingAddress(lock: IBitcoinLockRecord): string {
    const bitcoinLocks = this.getBitcoinLocks();
    bitcoinLocks.confirmAddress(lock);
    return bitcoinLocks.formatP2wshAddress(lock.lockDetails.p2wshScriptHashHex);
  }

  public async getMaximumChannelLiquidity(vault: Vault): Promise<bigint> {
    const { availableLiquidityMicrogons } = await this.getBitcoinLocks().getLockableBitcoinCapacity({
      vault,
      lockOwner: this.getLockOwner(),
    });
    return availableLiquidityMicrogons;
  }

  public isCreatingChannel(vaultId: number): boolean {
    return this.channelCreationsByVaultId.has(vaultId);
  }

  public createChannel(args: { vault: Vault; liquidityMicrogons: bigint }): Promise<IBitcoinLockRecord> {
    const vaultId = args.vault.vaultId;
    const existingCreation = this.channelCreationsByVaultId.get(vaultId);
    if (existingCreation) return existingCreation;

    const creation = this.beginChannelCreation(args).finally(() => {
      if (this.channelCreationsByVaultId.get(vaultId) === creation) {
        this.channelCreationsByVaultId.delete(vaultId);
      }
    });
    this.channelCreationsByVaultId.set(vaultId, creation);
    return creation;
  }

  private async beginChannelCreation(args: { vault: Vault; liquidityMicrogons: bigint }): Promise<IBitcoinLockRecord> {
    const { vault, liquidityMicrogons } = args;
    if (liquidityMicrogons <= 0n) throw new Error('Choose how much Bitcoin insurance you want.');

    const bitcoinLocks = this.getBitcoinLocks();
    const availableLiquidityMicrogons = await this.getMaximumChannelLiquidity(vault);
    if (liquidityMicrogons > availableLiquidityMicrogons) {
      throw new Error("This amount is above the vault's remaining Bitcoin capacity.");
    }

    const satoshis = await bitcoinLocks.satoshisForArgonLiquidity(liquidityMicrogons);
    const { pendingLock } = await bitcoinLocks.initializeLock({ vault, satoshis });
    return pendingLock;
  }
}
