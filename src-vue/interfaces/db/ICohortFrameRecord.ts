import type { ICohortRecord } from './ICohortRecord.ts';

export interface ICohortFrameRecord {
  frameId: number;
  cohortId: number;
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  microgonFeesCollectedTotal: bigint;
  createdAt: string;
  updatedAt: string;
}

export interface ICohortFrameStats {
  blocksMinedTotal: number;
  micronotsMinedTotal: bigint;
  microgonsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
}

export type IMiningCohortFinancialRecord = ICohortRecord &
  Pick<
    ICohortFrameRecord,
    'micronotsMinedTotal' | 'microgonsMinedTotal' | 'microgonsMintedTotal' | 'microgonFeesCollectedTotal'
  > & {
    closingArgonotPrice: bigint;
  };
