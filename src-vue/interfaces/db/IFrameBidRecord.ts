export interface IFrameBidRecord {
  frameId: number;
  confirmedAtBlockNumber: number;
  address: string;
  subAccountIndex?: number;
  microgonsPerSeat: bigint;
  micronotsStakedPerSeat: bigint;
  bidPosition: number;
  lastBidAtTick?: number;
  createdAt: string;
  updatedAt: string;
}
