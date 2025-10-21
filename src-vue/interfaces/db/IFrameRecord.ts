export interface IFrameRecord {
  id: number;
  progress: number;
  firstTick: number;
  lastTick: number;
  microgonToUsd: bigint[];
  microgonToBtc: bigint[];
  microgonToArgonot: bigint[];
  firstBlockNumber: number;
  lastBlockNumber: number;
  allMinersCount: number;
  seatCountActive: number;
  seatCostTotalFramed: bigint;
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  microgonFeesCollectedTotal: bigint;
  accruedMicrogonProfits: bigint;
  accruedMicronotProfits: bigint;
  isProcessed: boolean;
  createdAt: string;
  updatedAt: string;
}
