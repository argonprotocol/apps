import type { IBlockNumbers } from './IBlockNumbers.ts';
import type { ILastModifiedAt } from './ILastModified.ts';

export interface IBotStateStarting {
  isReady: boolean;
  isStarting?: boolean;
  isWaitingForBiddingRules?: boolean;
  isSyncing?: boolean;
  syncProgress: number;
  argonBlockNumbers: IBlockNumbers;
  bitcoinBlockNumbers: IBlockNumbers;
}

export interface IBotStateError extends IBotStateStarting {
  serverError: string | null;
}

export interface IBotSyncStatus {
  isReady: boolean;
  isStarting?: boolean;
  isWaitingForBiddingRules?: boolean;
  isSyncing?: boolean;
  maxSeatsInPlay?: number;
  maxSeatsReductionReason?: string;
}

export interface IBotState extends ILastModifiedAt, IBotSyncStatus, IBotStateFile {
  argonBlockNumbers: IBlockNumbers;
  bitcoinBlockNumbers: IBlockNumbers & { localNodeBlockTime: number };
  lastBlockNumber: number;
  syncedToBlockNumber: number;
  lastFinalizedBlockNumber: number;
  queueDepth: number;
  maxSeatsPossible: number;
  maxSeatsReductionReason: string;
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
  currentFrameTickRange: [number, number];
  lastBlockNumberByFrameId: {
    [frameId: number]: number;
  };
}
