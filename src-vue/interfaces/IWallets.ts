import type { IWallet } from '../lib/Wallet.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';

export interface IWalletsQueryRef {
  isLoaded: boolean;
  load(): Promise<void>;
  totalMiningMicrogons: bigint;
  defaultArgonWallet: IWallet;
  miningBotWallet: IWallet;
  ethereumWallets: { record: IWalletRecord; wallet: IWallet }[];
}
