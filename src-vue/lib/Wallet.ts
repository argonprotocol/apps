import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import type { Address } from 'viem';

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
};

export enum WalletType {
  miningHold = 'miningHold',
  miningBot = 'miningBot',
  vaulting = 'vaulting',
  operational = 'operational',
  investment = 'investment',
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
