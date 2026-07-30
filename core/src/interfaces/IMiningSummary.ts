export interface IMiningCohort {
  id: number;
  progress: number;
  transactionFeesTotal: bigint;
  micronotsStakedPerSeat: bigint;
  microgonsBidPerSeat: bigint;
  seatCountWon: number;
  microgonsToBeMinedPerSeat: bigint;
  micronotsToBeMinedPerSeat: bigint;
  argonotPriceAtBid: bigint;
  closingArgonotPrice: bigint;
}

export interface IMiningCohortFrame {
  frameId: number;
  cohortId: number;
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  microgonFeesCollectedTotal: bigint;
}

export type IMiningCohortFinancial = IMiningCohort &
  Pick<
    IMiningCohortFrame,
    'micronotsMinedTotal' | 'microgonsMinedTotal' | 'microgonsMintedTotal' | 'microgonFeesCollectedTotal'
  >;

export interface IMiningFrame {
  id: number;
  progress: number;
  firstTick: number;
  rewardTicksRemaining: number;
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
}

export interface IMiningBid {
  frameId: number;
  confirmedAtBlockNumber: number;
  address: string;
  subAccountIndex?: number;
  microgonsPerSeat: bigint;
  micronotsStakedPerSeat: bigint;
  bidPosition: number;
  lastBidAtTick?: number;
}

export interface IMiningGlobalStats {
  seatsTotal: number;
  framesCompleted: number;
  framesRemaining: number;
  framedCost: bigint;
  transactionFeesTotal: bigint;
  microgonsBidTotal: bigint;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
}

export interface IMiningSummary {
  observedAt: Date;
  sourceBlockNumber: number;
  latestFrameId: number;
  cohorts: IMiningCohortFinancial[];
  frames: IMiningFrame[];
  currentBids: IMiningBid[];
  global: IMiningGlobalStats;
}
