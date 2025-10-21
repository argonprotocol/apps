import type { ExtrinsicError } from '@argonprotocol/mainchain';
import type { ILastModifiedAt } from './ILastModified.ts';

export interface IHistoryFile extends ILastModifiedAt {
  activities: IBotActivity[];
}

export enum BotActivityType {
  Starting = 'Starting',
  DockersConfirmed = 'DockersConfirmed',
  StartedSyncing = 'StartedSyncing',
  FinishedSyncing = 'FinishedSyncing',
  Ready = 'Ready',
  Error = 'Error',
  Shutdown = 'Shutdown',

  BidsSubmitted = 'BidsSubmitted',
  BidsRejected = 'BidsRejected',
  BidReceived = 'BidReceived',
  AuctionStarted = 'AuctionStarted',
  AuctionFinished = 'AuctionFinished',
  SeatReduction = 'SeatReduction',
  SeatExpansion = 'SeatExpansion',
}

export type IBotActivityBasic = object;
export interface IBotActivityError extends IBotActivityBasic {
  name: string;
  message: string;
}

export interface IBotActivityBidsSubmitted extends IBotActivityBasic {
  microgonsPerSeat: bigint;
  txFeePlusTip: bigint;
  submittedCount: number;
}
export interface IBotActivityBidsRejected extends IBotActivityBasic {
  microgonsPerSeat: bigint;
  submittedCount: number;
  rejectedCount: number;
  bidError?: ExtrinsicError;
}
export interface IBotActivityBidReceived extends IBotActivityBasic {
  bidderAddress: string;
  microgonsPerSeat: bigint;
  bidPosition?: number;
  previousMicrogonsPerSeat?: bigint;
  previousBidPosition?: number;
}
export interface IBotActivityAuctionStarted extends IBotActivityBasic {
  maxSeatsInPlay: number;
  availableMicrogons: bigint;
}
export interface IBotActivityAuctionFinished extends IBotActivityBasic {
  seatCountWon: number;
  seatCountInAuction: number;
}
export interface IBotActivitySeatReduction extends IBotActivityBasic {
  reason: string;
  maxSeatsInPlay: number;
  prevSeatsInPlay: number;
  availableMicrogons: bigint;
  availableMicronots: bigint;
}
export interface IBotActivitySeatExpansion extends IBotActivityBasic {
  reason: string;
  maxSeatsInPlay: number;
  prevSeatsInPlay: number;
  availableMicrogons: bigint;
  availableMicronots: bigint;
}

// Mapping BotActivityType to their corresponding data interfaces
export type BotActivityDataMap = {
  [BotActivityType.Shutdown]: IBotActivityBasic;
  [BotActivityType.Starting]: IBotActivityBasic;
  [BotActivityType.DockersConfirmed]: IBotActivityBasic;
  [BotActivityType.StartedSyncing]: IBotActivityBasic;
  [BotActivityType.FinishedSyncing]: IBotActivityBasic;
  [BotActivityType.Ready]: IBotActivityBasic;
  [BotActivityType.Error]: IBotActivityError;
  [BotActivityType.BidsSubmitted]: IBotActivityBidsSubmitted;
  [BotActivityType.BidsRejected]: IBotActivityBidsRejected;
  [BotActivityType.BidReceived]: IBotActivityBidReceived;
  [BotActivityType.AuctionStarted]: IBotActivityAuctionStarted;
  [BotActivityType.AuctionFinished]: IBotActivityAuctionFinished;
  [BotActivityType.SeatReduction]: IBotActivitySeatReduction;
  [BotActivityType.SeatExpansion]: IBotActivitySeatExpansion;
};

// Discriminated union for IBotActivity
type IBotActivityBase = {
  id: number;
  tick: number;
  blockNumber?: number;
  frameId?: number;
};

export type IBotActivity = {
  [K in keyof BotActivityDataMap]: IBotActivityBase & { type: K; data: BotActivityDataMap[K] };
}[keyof BotActivityDataMap];
