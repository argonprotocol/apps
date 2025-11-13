export interface IDashboardGlobalStats {
  seatsTotal: number;
  framesCompleted: number;
  framesRemaining: number;
  framedCost: bigint;
  microgonsBidTotal: bigint;
  transactionFeesTotal: bigint;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
}

export interface IDashboardFrameStats {
  id: number;
  date: string;
  firstTick: number;
  lastTick: number;
  allMinersCount: number;
  seatCountActive: number;
  seatCostTotalFramed: bigint;
  accruedMicrogonProfits: bigint;
  blocksMinedTotal: number;
  microgonToUsd: bigint[];
  microgonToArgonot: bigint[];
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  micronotsMinedTotal: bigint;
  microgonFeesCollectedTotal: bigint;
  microgonValueOfRewards: bigint;
  progress: number;
  profit: number;
  profitPct: number;
  score: number;
  expected: IDashboardExpectedStats;
}

export interface IDashboardExpectedStats {
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
}
