import { bigIntMax, MICROGONS_PER_ARGON, type IBlockHeaderInfo, type IExtrinsicEvent } from '@argonprotocol/apps-core';
import { Db } from './Db.ts';
import { WalletForChain, WalletType } from './Wallet.ts';
import type { IWalletRecord } from './db/WalletsTable.ts';

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
  block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash' | 'blockTime' | 'isFinalized'>;
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

export type IArgonWalletType = 'argon' | 'miningBot' | 'operational';

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

export class WalletForArgon<TType extends IArgonWalletType = IArgonWalletType> extends WalletForChain<TType> {
  private _balanceHistory: IBalanceChange[] = [];

  constructor(
    type: TType,
    address: string,
    private db: Promise<Db>,
    record?: IWalletRecord,
  ) {
    super({ address, type, record });
  }

  public get balanceHistory(): IBalanceChange[] {
    return this._balanceHistory;
  }

  public set balanceHistory(balanceHistory: IBalanceChange[]) {
    this._balanceHistory = balanceHistory;
    const balance = this.latestBalanceChange;
    if (!balance) return;

    this.data.availableMicrogons = balance.availableMicrogons;
    this.data.availableMicronots = balance.availableMicronots;
    this.data.reservedMicrogons = balance.reservedMicrogons;
    this.data.reservedMicronots = balance.reservedMicronots;
    this.data.totalMicrogons = balance.availableMicrogons + balance.reservedMicrogons;
    this.data.totalMicronots = balance.availableMicronots + balance.reservedMicronots;
  }

  public get latestBalanceChange(): IBalanceChange | undefined {
    return this.balanceHistory.at(-1);
  }

  public get availableMicrogons(): bigint {
    return this.data.availableMicrogons;
  }

  public get availableMicronots(): bigint {
    return this.data.availableMicronots;
  }

  public get reservedMicrogons(): bigint {
    return this.data.reservedMicrogons;
  }

  public get reservedMicronots(): bigint {
    return this.data.reservedMicronots;
  }

  public get totalMicrogons(): bigint {
    return this.data.totalMicrogons;
  }

  public get totalMicronots(): bigint {
    return this.data.totalMicronots;
  }

  public hasValue(): boolean {
    return hasArgonWalletValue(this);
  }

  public hasDiff(balance1: IBalanceChange, balance2: IBalanceChange): boolean {
    return (
      balance1.availableMicrogons !== balance2.availableMicrogons ||
      balance1.reservedMicrogons !== balance2.reservedMicrogons ||
      balance1.availableMicronots !== balance2.availableMicronots ||
      balance1.reservedMicronots !== balance2.reservedMicronots
    );
  }

  public async saveFinalizedTransfers(
    historyEntry: Pick<IBalanceChange, 'block' | 'transfers'>,
    prices: { USD: bigint; ARGNOT: bigint },
  ): Promise<void> {
    if (!historyEntry.block.isFinalized) throw new Error('Cannot persist transfers from an unfinalized block');
    if (!historyEntry.transfers.length) return;

    const database = await this.db;
    for (const transfer of historyEntry.transfers) {
      await database.walletTransfersTable.insert({
        walletAddress: this.address,
        walletName: this.type,
        amount: transfer.isInbound ? transfer.amount : -transfer.amount,
        isInternal: transfer.isInternal,
        currency: transfer.currency,
        microgonsForArgonot: prices.ARGNOT,
        microgonsForUsd: prices.USD,
        extrinsicIndex: transfer.extrinsicIndex,
        otherParty: transfer.isInbound ? transfer.from : transfer.to,
        transferType: transfer.transferType,
        tokenGatewayCommitmentHash: transfer.tokenGatewayCommitmentHash,
        blockNumber: historyEntry.block.blockNumber,
        blockHash: historyEntry.block.blockHash,
        blockTime: new Date(historyEntry.block.blockTime),
      });
    }
  }
}
