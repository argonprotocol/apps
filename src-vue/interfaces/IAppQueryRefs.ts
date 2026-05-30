import type { ArgonClient } from '@argonprotocol/apps-core';
import type { IBitcoinLocksQueryRef } from './IBitcoinLocks.ts';
import type { IConfigQueryRef } from './IConfigQueryRef.ts';
import type { IEthereumMoveTrackerQueryRef } from './IEthereumInboundTransferTracker.ts';
import type { IMyVaultQueryRef } from './IMyVault.ts';
import type { IWalletsQueryRef } from './IWallets.ts';
import type { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import type { WalletType } from '../lib/Wallet.ts';

export interface IAppQueryRefs {
  config: IConfigQueryRef;
  bitcoinLocks: IBitcoinLocksQueryRef;
  myVault: IMyVaultQueryRef;
  wallets: IWalletsQueryRef;
  overlayIsOpen: boolean;
  getEthereumMoveTracker(): IEthereumMoveTrackerQueryRef;
  getEthereumOutboundTransferTracker(): EthereumOutboundTransferTracker;
  getMainchainClient(needsHistoricalAccess: boolean): Promise<ArgonClient>;
  openWalletOverlay(
    walletType: WalletType.miningHold | WalletType.vaulting | WalletType.investment | WalletType.ethereum,
  ): void;
}

export type IAppQueryFn<TResult = unknown, TArgs extends Record<string, unknown> = Record<string, never>> = (
  refs: IAppQueryRefs,
  args: TArgs,
) => TResult | Promise<TResult>;
