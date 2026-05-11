import type { ArgonClient } from '@argonprotocol/apps-core';
import type { IBitcoinLocksQueryRef } from './IBitcoinLocks.ts';
import type { IConfigQueryRef } from './IConfigQueryRef.ts';
import type { IEthereumMoveTrackerQueryRef } from './IEthereumInboundTransferTracker.ts';
import type { IMyVaultQueryRef } from './IMyVault.ts';
import type { IWalletsQueryRef } from './IWallets.ts';

export interface IAppQueryRefs {
  config: IConfigQueryRef;
  bitcoinLocks: IBitcoinLocksQueryRef;
  myVault: IMyVaultQueryRef;
  wallets: IWalletsQueryRef;
  overlayIsOpen: boolean;
  getEthereumMoveTracker(): IEthereumMoveTrackerQueryRef;
  getMainchainClient(needsHistoricalAccess: boolean): Promise<ArgonClient>;
}

export type IAppQueryFn<TResult = unknown, TArgs extends Record<string, unknown> = Record<string, never>> = (
  refs: IAppQueryRefs,
  args: TArgs,
) => TResult | Promise<TResult>;
