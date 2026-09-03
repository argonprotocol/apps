import type { TxSigningAccount, Vault } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockProcessingDetails } from '../interfaces/IBitcoinLockSummary.ts';
import BitcoinLocks, { type IOperatorBitcoinLockCouponRoute } from './BitcoinLocks.ts';
import type { BitcoinLockCreate } from './txs/BitcoinLock.create.ts';
import { WalletForChain, WalletType } from './Wallet.ts';

const channelStatusOrder: readonly BitcoinLockStatus[] = [
  BitcoinLockStatus.LockFunded,
  BitcoinLockStatus.Releasing,
  BitcoinLockStatus.LockPendingFunding,
  BitcoinLockStatus.LockIsProcessingOnArgon,
];

export class WalletForBitcoin extends WalletForChain<WalletType.bitcoin> {
  private readonly channelCreationsByVaultId = Vue.reactive(new Map<number, Promise<IBitcoinLockRecord>>());

  constructor(
    private readonly getBitcoinLocks: () => BitcoinLocks,
    private readonly getLockOwner: () => string,
    private readonly bitcoinLockCreate: BitcoinLockCreate,
    address = '',
  ) {
    super({ address, type: WalletType.bitcoin });
  }

  public async loadChannels(): Promise<void> {
    await this.getBitcoinLocks().load();
  }

  public getChannels(): IBitcoinLockRecord[] {
    return this.getBitcoinLocks()
      .getAllLocks()
      .filter(lock => {
        return ![
          BitcoinLockStatus.LockFailed,
          BitcoinLockStatus.LockFailedAcknowledged,
          BitcoinLockStatus.Released,
        ].includes(lock.status);
      })
      .sort((left, right) => {
        const lifecycleOrder = channelStatusOrder.indexOf(left.status) - channelStatusOrder.indexOf(right.status);
        return lifecycleOrder || right.updatedAt.getTime() - left.updatedAt.getTime();
      });
  }

  public getArchivedChannels(): IBitcoinLockRecord[] {
    return this.getBitcoinLocks()
      .getAllLocks()
      .filter(lock => lock.status === BitcoinLockStatus.Released)
      .sort((left, right) => {
        const leftReleasedAt = left.removalBlockTime ?? left.updatedAt;
        const rightReleasedAt = right.removalBlockTime ?? right.updatedAt;
        return rightReleasedAt.getTime() - leftReleasedAt.getTime();
      });
  }

  public getPendingChannelFundings(): IBitcoinLockRecord[] {
    return this.getChannels().filter(lock => {
      return lock.status === BitcoinLockStatus.LockPendingFunding && this.hasObservedChannelFunding(lock);
    });
  }

  public getPendingChannelReleases(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return this.getChannels().filter(lock => {
      const releaseState = bitcoinLocks.getLockUnlockReleaseState(lock);
      return releaseState.isReleaseStatus && !releaseState.isReleaseComplete;
    });
  }

  public getSendableChannels(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return this.getChannels().filter(lock => {
      return bitcoinLocks.isLockFunded(lock) && (lock.fissionedSatoshis ?? 0n) === 0n;
    });
  }

  public getLiquidLockedChannels(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return this.getChannels().filter(lock => {
      return bitcoinLocks.isLockFunded(lock) && (lock.fissionedSatoshis ?? 0n) > 0n;
    });
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
    return bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
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

  public createChannel(args: {
    vault: Vault;
    liquidityMicrogons: bigint;
    txSigner: TxSigningAccount;
    operatorCoupon?: IOperatorBitcoinLockCouponRoute;
  }): Promise<IBitcoinLockRecord> {
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

  private async beginChannelCreation(args: {
    vault: Vault;
    liquidityMicrogons: bigint;
    txSigner: TxSigningAccount;
    operatorCoupon?: IOperatorBitcoinLockCouponRoute;
  }): Promise<IBitcoinLockRecord> {
    const { vault, liquidityMicrogons, txSigner, operatorCoupon } = args;
    if (liquidityMicrogons < 0n) throw new Error('Bitcoin insurance cannot be negative.');

    const bitcoinLocks = this.getBitcoinLocks();
    const availableLiquidityMicrogons = await this.getMaximumChannelLiquidity(vault);
    if (liquidityMicrogons > availableLiquidityMicrogons) {
      throw new Error("This amount is above the vault's remaining Bitcoin capacity.");
    }

    const txInfo = await this.bitcoinLockCreate.submit({
      vault,
      satoshis: liquidityMicrogons === 0n ? 0n : await bitcoinLocks.satoshisForArgonLiquidity(liquidityMicrogons),
      txSigner,
      operatorCoupon,
    });
    const pendingLock = bitcoinLocks.getLockByUuid(txInfo.tx.metadataJson.bitcoin.uuid);
    if (!pendingLock) throw new Error('Pending Bitcoin lock was not published after submission.');
    return pendingLock;
  }
}
