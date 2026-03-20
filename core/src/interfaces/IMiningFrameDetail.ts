import type { IWinningBid } from './IBidsFile.ts';
import type { IMiningSlot } from '../Mining.ts';

export interface IMiningFrameDetail {
  frameId: number;
  auctionCloseTick?: number;
  expectedAuctionCloseTick?: number;
  totalBidCount: number;
  myLastBidMicrogons?: bigint;
  winningBids: (IWinningBid & { micronotsStakedPerSeat: bigint })[];
  slots: IMiningSlot[];
}
