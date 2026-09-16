import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { Address } from 'viem';
import type { Currency } from './Currency.ts';
import type { IWalletRecord } from './db/WalletsTable.ts';

type IOtherChain = 'ethereum' | 'base';

export type IOtherTokenDefinition = {
  symbol: string;
  decimals: number;
  address: Address | null;
  chain: IOtherChain;
  unitOfMeasurement: UnitOfMeasurement;
};

export type IOtherToken = IOtherTokenDefinition & {
  value: bigint;
};

export enum WalletType {
  argon = 'argon',
  bitcoin = 'bitcoin',
  miningBot = 'miningBot',
  operational = 'operational',
  ethereum = 'ethereum',
}

export type IWalletType = keyof typeof WalletType;

export type IWallet = {
  type: IWalletType | 'base';
  address: string;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
  totalMicrogons: bigint;
  totalMicronots: bigint;
  otherTokens: IOtherToken[];
  fetchErrorMsg: string;
  balanceUpdatedAt?: Date;
  balanceIsCached?: boolean;
};

export type IWalletData<TType extends IWallet['type'] = IWallet['type']> = Omit<IWallet, 'type'> & { type: TType };

export const defaultWalletData: Omit<IWallet, 'type'> = {
  address: '',
  availableMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicrogons: 0n,
  reservedMicronots: 0n,
  totalMicrogons: 0n,
  totalMicronots: 0n,
  otherTokens: [],
  fetchErrorMsg: '',
};

export abstract class WalletForChain<TType extends IWallet['type']> {
  public record?: IWalletRecord;
  public data: IWalletData<TType>;

  protected constructor({ address, type, record }: { address: string; type: TType; record?: IWalletRecord }) {
    if (record && record.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`Wallet record ${record.id} does not match wallet address ${address}`);
    }
    this.record = record;
    this.data = {
      ...defaultWalletData,
      type,
      address,
    };
  }

  public get address(): string {
    return this.data.address;
  }

  public get type(): TType {
    return this.data.type;
  }

  public setRecord(record: IWalletRecord | undefined): void {
    if (record && record.address.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(`Wallet record ${record.id} does not match wallet address ${this.address}`);
    }
    this.record = record;
  }
}

export function getWalletTotalValue(wallet: IWallet, currency: Currency): bigint {
  const micronotValue = currency.convertMicronotTo(wallet.totalMicronots, UnitOfMeasurement.Microgon);
  const otherTokenValue = wallet.otherTokens.reduce((total, token) => {
    return total + currency.convertOtherToMicrogon(token);
  }, 0n);
  return wallet.totalMicrogons + micronotValue + otherTokenValue;
}

export function getWalletArgonValue(wallet: IWallet, currency: Currency): bigint {
  const micronotValue = currency.convertMicronotTo(wallet.totalMicronots, UnitOfMeasurement.Microgon);
  return wallet.totalMicrogons + micronotValue;
}

export function getEthereumWalletDisplayName(name: string): string {
  const trimmedName = name.trim();
  return /(?:^|\s)wallet$/i.test(trimmedName) ? trimmedName : `${trimmedName} Wallet`;
}
