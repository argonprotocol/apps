import type { IBlockNumbers } from './IBlockNumbers.ts';
import type { IBidReductionReason } from '../CohortBidder.js';
import type { IWinningBid } from './IBidsFile.ts';

export type IEthereumSyncMode = 'disabled' | 'needsBootstrap' | 'idle' | 'submitting' | 'error';

export interface IEthereumSyncStatus {
  mode: IEthereumSyncMode;
  syncAccountAddress: string;
  lastUpdatedAt?: Date;
  latestFinalizedSlot?: bigint;
  latestExecutionAnchorBlockNumber?: bigint;
  latestEthereumBlockNumber?: bigint;
  latestSyncCommitteeUpdatePeriod?: bigint;
  lastSubmittedTxHash?: string;
  gatewayActivityNonceGap?: bigint;
  lastError?: string;
}

export interface IBotStateStarting {
  isReady: boolean;
  isStarting?: boolean;
  isSyncing?: boolean;
  syncProgress: number;
  argonBlockNumbers: IBlockNumbers;
  bitcoinBlockNumbers: IBlockNumbers & { localNodeBlockTime: number };
  serverError: string | null;
  ethereumSync?: IEthereumSyncStatus;
}

export interface IBotSyncStatus extends IBotStateStarting {
  maxSeatsInPlay: number;
  maxSeatsReductionReason?: IBidReductionReason;
  maximumBidMicrogonsPerSeat?: bigint;
}

export interface IBotState extends IBotSyncStatus, IBotStateFile {
  botLastActiveDate: Date;
  botLastActiveBlockNumber: number;
  bidsInCurrentFrame: number;
  bidsInPreviousFrame: number;
  isBiddingOpen: boolean;
  winningBids: IWinningBid[];
  currentAuctionSeatCount?: number;
  currentAuctionMicronotsPerSeat?: bigint;
  seatGoalCount?: number;
  botCapital?: {
    microgons: bigint;
    micronots: bigint;
  };
  nextBid?: {
    atTick: number;
    microgonsPerSeat: bigint;
    alreadyWinningSeats: number;
    seats: number;
  };
  lastBid?: {
    submittedAtTick: number;
    expectedFinalizationTick: number;
    isFinalized: boolean;
    microgonsPerSeat: bigint;
    seats: number;
    seatsWon?: number;
  };
}

export interface IBotStateFile {
  bidsLastModifiedAt: Date;
  earningsLastModifiedAt: Date;
  oldestFrameIdToSync: number;
  syncProgress: number;
  hasMiningBids: boolean;
  hasMiningSeats: boolean;
  currentTick: number;
  currentFrameId: number;
  finalizedFrameId: number;
}
