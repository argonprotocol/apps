import type { IWallet } from '../lib/Wallet.ts';

export interface IWalletsQueryRef {
  isLoaded: boolean;
  load(): Promise<void>;
  totalMiningMicrogons: bigint;
  miningHoldWallet: IWallet;
  miningBotWallet: IWallet;
  vaultingWallet: IWallet;
  investmentWallet: IWallet;
  ethereumWallet: IWallet;
}
