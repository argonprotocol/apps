import type { ILastModifiedAt } from './ILastModified.ts';

export interface IEarningsFile extends ILastModifiedAt {
  frameId: number;
  frameFirstTick: number;
  frameRewardTicksRemaining: number;
  firstBlockNumber: number;
  lastBlockNumber: number;
  microgonToUsd: bigint[];
  microgonToBtc: bigint[];
  microgonToArgonot: bigint[];

  earningsByBlock: {
    [blockNumber: number]: IBlockEarningsSummary;
  };
}

export interface IBlockEarningsSummary {
  blockHash: string;
  blockMinedAt: string;
  authorCohortActivationFrameId: number;
  authorAddress: string;
  microgonsMined: bigint;
  microgonsMinted: bigint;
  // A frame's mint pays every active cohort, even when another account authored the block.
  microgonsMintedByCohort?: Record<number, bigint>;
  micronotsMined: bigint;
  microgonFeesCollected: bigint;
}

export interface IFrameEarningsRollup {
  lastBlockMinedAt: string;
  blocksMinedTotal: number;
  microgonFeesCollectedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  micronotsMinedTotal: bigint;
}
