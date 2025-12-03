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

  transactionFeesTotal: bigint;
  accruedMicrogonProfits: bigint;
  accruedMicronotProfits: bigint;
  previousFrameAccruedMicrogonProfits: bigint | null;
  previousFrameAccruedMicronotProfits: bigint | null;

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
