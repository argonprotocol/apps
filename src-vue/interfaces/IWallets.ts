import type { IWallet } from '../lib/Wallet.ts';

export interface IWalletsQueryRef {
  isLoaded: boolean;
  load(): Promise<void>;
  totalMiningMicrogons: bigint;
  defaultArgonWallet: IWallet;
  miningBotWallet: IWallet;
  ethereumWallets: {
    length: number;
    persistedWallets: Array<{ address: string; data: IWallet }>;
  };
}
