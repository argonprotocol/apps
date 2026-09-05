import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import type { IBitcoinLiquidCreatePreview } from '../lib/txs/BitcoinLiquid.create.ts';

export type BitcoinLiquidCreationState = {
  stage: 'form' | 'creating' | 'complete';
  sources: IBitcoinLiquidSource[];
  preview?: IBitcoinLiquidCreatePreview;
  isSubmitting: boolean;
  progressPct: number;
  progressLabel: string;
  errorMessage: string;
  treasuryCertificationRequiredSatoshis: bigint;
};
