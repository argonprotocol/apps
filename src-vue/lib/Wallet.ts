import { Db } from './Db.ts';
import { IBlockToProcess } from './WalletBalances.ts';
import { IBalanceTransfer, IExtrinsicEvent, IVaultRevenueEvent } from '@argonprotocol/apps-core';

export type IBalanceChange = {
  block: IBlockToProcess;
  vaultRevenueEvents: IVaultRevenueEvent[];
  microgonsAdded: bigint;
  micronotsAdded: bigint;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
  extrinsicEvents: IExtrinsicEvent[];
  transfers: IBalanceTransfer[];
};

export type IWallet = {
  address: string;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
  totalMicrogons: bigint;
  totalMicronots: bigint;
};

export type IWalletType = 'mining' | 'vaulting' | 'holding';

export class Wallet implements IWallet {
  public balanceHistory: IBalanceChange[];

  constructor(
    public address: string,
    public type: IWalletType,
    private db: Promise<Db>,
  ) {
    this.balanceHistory = [];
  }

  public get finalizedBalance(): IBalanceChange | undefined {
    return this.balanceHistory.at(0);
  }

  public get latestBalanceChange(): IBalanceChange | undefined {
    return this.balanceHistory.at(-1);
  }

  public get availableMicrogons(): bigint {
    return this.latestBalanceChange?.availableMicrogons ?? 0n;
  }

  public get availableMicronots(): bigint {
    return this.latestBalanceChange?.availableMicronots ?? 0n;
  }

  public get reservedMicrogons(): bigint {
    return this.latestBalanceChange?.reservedMicrogons ?? 0n;
  }

  public get reservedMicronots(): bigint {
    return this.latestBalanceChange?.reservedMicronots ?? 0n;
  }

  public get totalMicrogons(): bigint {
    return this.availableMicrogons + this.reservedMicrogons;
  }

  public get totalMicronots(): bigint {
    return this.availableMicronots + this.reservedMicronots;
  }

  public hasValue(): boolean {
    if (this.availableMicrogons > 0n) return true;
    if (this.availableMicronots > 0n) return true;
    if (this.reservedMicronots > 0n) return true;
    if (this.reservedMicrogons > 0n) return true;
    return false;
  }

  public dropBlock(blockHash: string) {
    const index = this.balanceHistory.findIndex(b => b.block.blockHash === blockHash);
    if (index === -1) {
      return;
    }
    this.balanceHistory.splice(index, 1);
  }

  public addDiffs(newBalance: IBalanceChange): boolean {
    const last = this.latestBalanceChange;
    if (!last) {
      return true;
    }
    newBalance.microgonsAdded = newBalance.availableMicrogons + newBalance.reservedMicrogons - this.totalMicrogons;
    newBalance.micronotsAdded = newBalance.availableMicronots + newBalance.reservedMicronots - this.totalMicronots;
    return this.hasDiff(last, newBalance);
  }

  public hasDiff(balance1: IBalanceChange, balance2: IBalanceChange): boolean {
    return (
      balance1.availableMicrogons !== balance2.availableMicrogons ||
      balance1.reservedMicrogons !== balance2.reservedMicrogons ||
      balance1.availableMicronots !== balance2.availableMicronots ||
      balance1.reservedMicronots !== balance2.reservedMicronots
    );
  }

  public async onBalanceChange(newBalance: IBalanceChange, prices: { USD: bigint; ARGNOT: bigint }): Promise<boolean> {
    const prev = this.latestBalanceChange;
    if (!prev) {
      this.balanceHistory.push(newBalance);
      return true;
    }

    if (prev.block.blockHash === newBalance.block.blockHash || prev.block.blockNumber >= newBalance.block.blockNumber) {
      return false;
    }

    this.balanceHistory.push(newBalance);
    const hasChange = this.hasDiff(prev, newBalance);
    if (hasChange) {
      const database = await this.db;
      await database.walletLedgerTable.insert({
        walletAddress: this.address,
        walletName: this.type,
        availableMicrogons: newBalance.availableMicrogons,
        availableMicronots: newBalance.availableMicronots,
        reservedMicrogons: newBalance.reservedMicrogons,
        reservedMicronots: newBalance.reservedMicronots,
        microgonChange: newBalance.microgonsAdded,
        micronotChange: newBalance.micronotsAdded,
        microgonsForUsd: prices.USD,
        microgonsForArgonot: prices.ARGNOT,
        extrinsicEventsJson: newBalance.extrinsicEvents,
        blockNumber: newBalance.block.blockNumber,
        blockHash: newBalance.block.blockHash,
        isFinalized: newBalance.block.isFinalized,
      });
      for (const transfer of newBalance.transfers) {
        await database.walletTransfersTable.insert({
          walletAddress: this.address,
          walletName: this.type,
          amount: transfer.isInbound ? transfer.amount : -transfer.amount,
          isInternal: transfer.isInternal,
          currency: transfer.isOwnership ? 'argonot' : 'argon',
          microgonsForArgonot: prices.ARGNOT,
          microgonsForUsd: prices.USD,
          extrinsicIndex: transfer.extrinsicIndex,
          otherParty: transfer.isInbound ? transfer.from : transfer.to,
          transferType: transfer.transferType,
          blockNumber: newBalance.block.blockNumber,
          blockHash: newBalance.block.blockHash,
        });
      }
      for (const revenueEvent of newBalance.vaultRevenueEvents) {
        await database.vaultRevenueEventsTable.insert({
          amount: revenueEvent.amount,
          source: revenueEvent.source,
          blockNumber: newBalance.block.blockNumber,
          blockHash: newBalance.block.blockHash,
        });
      }
    }

    return hasChange;
  }
}
