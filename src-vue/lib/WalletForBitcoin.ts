import { bigIntMax, type TxSigningAccount, type Vault } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockProcessingDetails } from '../interfaces/IBitcoinLockSummary.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../interfaces/IBitcoinUtxoRecord.ts';
import BitcoinLocks, { type IOperatorBitcoinLockCouponRoute } from './BitcoinLocks.ts';
import type { BitcoinLockCreate } from './txs/BitcoinLock.create.ts';
import { WalletForChain, WalletType } from './Wallet.ts';

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
    await this.getBitcoinLocks().currentLoadPromise;
  }

  public getOpenInboundChannel(): IBitcoinLockRecord | undefined {
    return this.getBitcoinLocks()
      .getAllLocks()
      .filter(lock => this.isOpenInboundChannel(lock))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
  }

  public isOpenInboundChannel(lock: IBitcoinLockRecord): boolean {
    if (lock.status === BitcoinLockStatus.LockIsProcessingOnArgon) return true;
    const canReceiveFunding =
      lock.status === BitcoinLockStatus.LockPendingFunding || lock.status === BitcoinLockStatus.LockFunded;
    return canReceiveFunding && !this.getBitcoinLocks().isFundingWindowExpired(lock);
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
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks
      .getAllLocks()
      .filter(
        lock => lock.status === BitcoinLockStatus.LockPendingFunding && bitcoinLocks.hasObservedFundingSignal(lock),
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  public getPendingChannelReleases(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks
      .getAllLocks()
      .filter(lock => {
        const releaseState = bitcoinLocks.getLockUnlockReleaseState(lock);
        return releaseState.isReleaseStatus && !releaseState.isReleaseComplete;
      })
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  public getSendableChannels(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks
      .getAllLocks()
      .filter(lock => bitcoinLocks.isLockFunded(lock) && (lock.fissionedSatoshis ?? 0n) === 0n);
  }

  public getLiquidLockedChannels(): IBitcoinLockRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks
      .getAllLocks()
      .filter(lock => bitcoinLocks.isLockFunded(lock) && (lock.fissionedSatoshis ?? 0n) > 0n);
  }

  public getUnresolvedOrphanDeposits(): IBitcoinUtxoRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords(bitcoinLocks.getAllLocks());
  }

  public getPendingUnattachedDeposits(): IBitcoinUtxoRecord[] {
    const bitcoinLocks = this.getBitcoinLocks();
    return bitcoinLocks
      .getAllLocks()
      .flatMap(lock => {
        const records = bitcoinLocks.utxoTracking.getUtxosForLock(lock);
        const acceptedFundingId = lock.fundingUtxo?.id;
        const observedFundingId =
          lock.status === BitcoinLockStatus.LockPendingFunding && !bitcoinLocks.isFundingWindowExpired(lock)
            ? bitcoinLocks.utxoTracking.getObservedFundingRecord(lock)?.id
            : undefined;
        return records.filter(record => {
          return (
            record.status === BitcoinUtxoStatus.SeenOnMempool &&
            record.id !== acceptedFundingId &&
            record.id !== observedFundingId
          );
        });
      })
      .sort((left, right) => right.firstSeenAt.getTime() - left.firstSeenAt.getTime());
  }

  public getRemainingChannelInsurance(lock: IBitcoinLockRecord): bigint {
    const bitcoinLocks = this.getBitcoinLocks();
    const filledInsuranceMicrogons = bitcoinLocks.argonLiquidityForSatoshis(
      lock.fundedSatoshis,
      lock.microgonsAtTargetPerBtc,
    );
    return bigIntMax((lock.securitizationCoverageMicrogons ?? 0n) - filledInsuranceMicrogons, 0n);
  }

  public getChannel(uuid: string): IBitcoinLockRecord | undefined {
    return this.getBitcoinLocks()
      .getAllLocks()
      .find(lock => lock.uuid === uuid);
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
    const openChannel = this.getOpenInboundChannel();
    if (openChannel) return Promise.resolve(openChannel);

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
