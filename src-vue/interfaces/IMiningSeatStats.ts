import type { IMiningCohort, IMiningFrame, IMiningGlobalStats } from '@argonprotocol/apps-core';

export type IMiningSeatRewardTerms = Pick<
  IMiningCohort,
  'microgonsToBeMinedPerSeat' | 'micronotsToBeMinedPerSeat' | 'argonotPriceAtBid'
>;

/** Aggregated mining-seat history shown by the operator mining dashboard. */
export type IDashboardGlobalStats = IMiningGlobalStats & {
  microgonValueOfRewards: bigint;
};

export type IDashboardFrameStats = Pick<
  IMiningFrame,
  | 'id'
  | 'firstTick'
  | 'allMinersCount'
  | 'seatCountActive'
  | 'seatCostTotalFramed'
  | 'accruedMicrogonProfits'
  | 'blocksMinedTotal'
  | 'microgonToUsd'
  | 'microgonToArgonot'
  | 'microgonsMinedTotal'
  | 'microgonsMintedTotal'
  | 'micronotsMinedTotal'
  | 'microgonFeesCollectedTotal'
  | 'progress'
> & {
  date: string;
  microgonValueOfRewards: bigint;
  profit: number;
  profitPct: number;
  score: number;
  expected: IDashboardExpectedStats;
};

export interface IDashboardExpectedStats {
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  microgonValueOfRewards: bigint;
}
