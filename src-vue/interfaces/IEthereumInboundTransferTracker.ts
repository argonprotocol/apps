import { MoveToken } from '@argonprotocol/apps-core';
import { WalletType } from '../lib/Wallet.ts';

export type IArgonWalletType = WalletType.investment | WalletType.miningHold | WalletType.vaulting;

export type IEthereumMoveToken = MoveToken.ARGN | MoveToken.ARGNOT;

export type IEthereumInboundTransferPhase =
  | 'idle'
  | 'preparing'
  | 'awaitingEthereumApproval'
  | 'awaitingEthereumBurn'
  | 'waitingForRetainedAnchor'
  | 'confirmingArgon'
  | 'confirmedOnArgon';

export interface IEthereumInboundSourceFinalization {
  startedAt: number;
  estimatedDurationMs: number;
  pollMs: number;
}

export interface IEthereumInboundArgonProgress {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
}

export interface IEthereumInboundTransferState {
  isSubmitting: boolean;
  hasPersistedTransfer: boolean;
  targetWalletType?: IArgonWalletType;
  phase: IEthereumInboundTransferPhase;
  error: string;
  sourceFinalization?: IEthereumInboundSourceFinalization;
  argonProgress?: IEthereumInboundArgonProgress;
}

export interface IEthereumMoveTrackerQueryRef {
  getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumInboundTransferState;
}
