import type { ILastModifiedAt } from './ILastModified.ts';

export interface IBidsFile extends ILastModifiedAt {
  cohortBiddingFrameId: number;
  cohortActivationFrameId: number;
  biddingFrameFirstTick: number;
  biddingFrameRewardTicksRemaining: number;
  lastBlockNumber: number;
  microgonsBidTotal: bigint;
  transactionFeesByBlock: { [blockNumber: number]: bigint };
  micronotsStakedPerSeat: bigint;
  microgonsToBeMinedPerBlock: bigint;
  seatCountWon: number;
  allMinersCount: number;
  winningBids: Array<IWinningBid>;
}

export interface IWinningBid {
  address: string;
  subAccountIndex?: number;
  lastBidAtTick?: number;
  bidPosition?: number;
  microgonsPerSeat?: bigint;
}
