import { MoveToken } from '@argonprotocol/apps-core';
import type { ICrosschainTransferProgress } from '../lib/CrosschainTransferProgress.ts';
import { WalletType } from '../lib/Wallet.ts';

export type IArgonWalletType = WalletType.investment | WalletType.miningHold | WalletType.vaulting;

export type IEthereumMoveToken = MoveToken.ARGN | MoveToken.ARGNOT;

export interface IEthereumInboundTransferState {
  isSubmitting: boolean;
  hasPersistedTransfer: boolean;
  needsAcknowledgement: boolean;
  targetWalletType?: IArgonWalletType;
  progress: ICrosschainTransferProgress;
  error: string;
}

export interface IEthereumMoveTrackerQueryRef {
  getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumInboundTransferState;
}
