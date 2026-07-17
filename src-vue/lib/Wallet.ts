import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { Address } from 'viem';
import type { Currency } from './Currency.ts';

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

export type IWallet = {
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

export enum WalletType {
  defaultArgon = 'defaultArgon',
  miningBot = 'miningBot',
  operational = 'operational',
  ethereum = 'ethereum',
}

export type IWalletType = keyof typeof WalletType;

export const defaultWalletData: IWallet = {
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

export function getWalletTotalValue(wallet: IWallet, currency: Currency): bigint {
  const micronotValue = currency.convertMicronotTo(wallet.totalMicronots, UnitOfMeasurement.Microgon);
  const otherTokenValue = wallet.otherTokens.reduce((total, token) => {
    return total + currency.convertOtherToMicrogon(token);
  }, 0n);
  return wallet.totalMicrogons + micronotValue + otherTokenValue;
}
