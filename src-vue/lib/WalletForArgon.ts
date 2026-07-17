import { bigIntMax, MICROGONS_PER_ARGON, type IExtrinsicEvent } from '@argonprotocol/apps-core';
import { Db } from './Db.ts';
import type { IBlockToProcess } from './WalletsForArgon.ts';
import { type IWallet, WalletType } from './Wallet.ts';

export type IWalletBalanceTransfer = {
  to: string;
  from?: string;
  transferType: 'transfer' | 'faucet' | 'tokenGateway' | 'ethereum';
  currency: 'argon' | 'argonot';
  isInternal: boolean;
  isInbound: boolean;
  amount: bigint;
  extrinsicIndex: number;
  tokenGatewayCommitmentHash?: string;
};

export type IBalanceChange = {
  block: Pick<IBlockToProcess, 'blockNumber' | 'blockHash' | 'blockTime' | 'isFinalized'>;
  microgonsAdded: bigint;
  micronotsAdded: bigint;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
  extrinsicEvents: IExtrinsicEvent[];
  transfers: IWalletBalanceTransfer[];
};

export const existentialDepositMicrogons = 10_000n;
export const existentialDepositMicronots = 10_000n;
export const defaultArgonOperationalReserveMicrogons = BigInt(MICROGONS_PER_ARGON);

export function getSpendableMicrogons(availableMicrogons: bigint, reserveMicrogons = 0n): bigint {
  return bigIntMax(availableMicrogons - reserveMicrogons, 0n);
}

export function getSpendableDefaultArgonMicrogons(availableMicrogons: bigint): bigint {
  return getSpendableMicrogons(availableMicrogons, defaultArgonOperationalReserveMicrogons);
}

export type IWalletType = keyof typeof WalletType;
export type IArgonWalletType = Exclude<IWalletType, 'ethereum'>;

export function hasArgonWalletValue(balance: {
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
}): boolean {
  if (balance.availableMicrogons > 0n) return true;
  if (balance.availableMicronots > 0n) return true;
  if (balance.reservedMicronots > 0n) return true;
  if (balance.reservedMicrogons > 0n) return true;
  return false;
}

export class WalletForArgon implements IWallet {
  public balanceHistory: IBalanceChange[];
  public fetchErrorMsg = '';
  public otherTokens = [];

  constructor(
    public address: string,
    public type: IArgonWalletType,
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
    return hasArgonWalletValue(this);
  }

  public trimToFinalizedBlock(finalizedBlock: { blockNumber: number; blockHash: string }) {
    const { blockNumber: finalizedBlockNumber } = finalizedBlock;
    const newHistory: IBalanceChange[] = [];
    for (const history of this.balanceHistory) {
      history.block.isFinalized = history.block.blockNumber <= finalizedBlockNumber;
      if (history.block.blockNumber >= finalizedBlockNumber) {
        newHistory.push(history);
      }
    }
    if (newHistory.length === 0 || !newHistory.some(x => x.block.isFinalized)) {
      // need at least one finalized entry
      let finalized: IBalanceChange | undefined;
      for (let i = this.balanceHistory.length - 1; i >= 0; i--) {
        if (this.balanceHistory[i].block.isFinalized) {
          finalized = this.balanceHistory[i];
          break;
        }
      }
      if (finalized) {
        newHistory.unshift(finalized);
      }
      if (!newHistory.length) {
        console.warn(
          'Cannot trim wallet balance history, no finalized block found',
          { block: finalizedBlock, wallet: this.address },
          this.balanceHistory,
        );
        throw new Error(
          `Cannot trim wallet ${this.address} balance history to block ${finalizedBlockNumber}, no finalized block found`,
        );
      }
    }
    this.balanceHistory = newHistory;
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
    newBalance.microgonsAdded = newBalance.availableMicrogons + newBalance.reservedMicrogons - this.totalMicrogons;
    newBalance.micronotsAdded = newBalance.availableMicronots + newBalance.reservedMicronots - this.totalMicronots;
    return !last || this.hasDiff(last, newBalance);
  }

  public hasDiff(balance1: IBalanceChange, balance2: IBalanceChange): boolean {
    return (
      balance1.availableMicrogons !== balance2.availableMicrogons ||
      balance1.reservedMicrogons !== balance2.reservedMicrogons ||
      balance1.availableMicronots !== balance2.availableMicronots ||
      balance1.reservedMicronots !== balance2.reservedMicronots
    );
  }

  public async onBalanceChange(newBalance: IBalanceChange, prices?: { USD: bigint; ARGNOT: bigint }): Promise<boolean> {
    const prev = this.latestBalanceChange;
    let hasChange = true;
    if (prev) {
      if (
        prev.block.blockHash === newBalance.block.blockHash ||
        prev.block.blockNumber >= newBalance.block.blockNumber
      ) {
        return false;
      }
      hasChange = this.hasDiff(prev, newBalance);
    }

    if (newBalance.block.isFinalized && newBalance.transfers.length) {
      if (!prices) throw new Error('Finalized wallet transfers require the rates from their block');
      await this.saveFinalizedTransfers(newBalance, prices);
    }
    this.balanceHistory.push(newBalance);
    if (!hasChange) return false;
    // skip writing to db if this is an empty account
    if (
      !prev &&
      newBalance.availableMicrogons === 0n &&
      newBalance.availableMicronots === 0n &&
      newBalance.reservedMicrogons === 0n &&
      newBalance.reservedMicronots === 0n
    ) {
      // no change from zero balance
      return false;
    }

    return true;
  }

  public async saveFinalizedTransfers(balance: IBalanceChange, prices: { USD: bigint; ARGNOT: bigint }): Promise<void> {
    if (!balance.block.isFinalized) throw new Error('Cannot persist transfers from an unfinalized block');
    if (!balance.transfers.length) return;

    const database = await this.db;
    for (const transfer of balance.transfers) {
      let amount = transfer.amount;
      let isInbound = transfer.isInbound;
      if (transfer.transferType === 'faucet') {
        const balanceChange = transfer.currency === 'argon' ? balance.microgonsAdded : balance.micronotsAdded;
        if (balanceChange === 0n) continue;

        isInbound = balanceChange > 0n;
        amount = isInbound ? balanceChange : -balanceChange;
      }
      await database.walletTransfersTable.insert({
        walletAddress: this.address,
        walletName: this.type,
        amount: isInbound ? amount : -amount,
        isInternal: transfer.isInternal,
        currency: transfer.currency,
        microgonsForArgonot: prices.ARGNOT,
        microgonsForUsd: prices.USD,
        extrinsicIndex: transfer.extrinsicIndex,
        otherParty: isInbound ? transfer.from : transfer.to,
        transferType: transfer.transferType,
        tokenGatewayCommitmentHash: transfer.tokenGatewayCommitmentHash,
        blockNumber: balance.block.blockNumber,
        blockHash: balance.block.blockHash,
        blockTime: new Date(balance.block.blockTime),
      });
    }
  }
}
