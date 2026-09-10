import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import type { IBitcoinLiquidCreatePreview } from '../lib/txs/BitcoinLiquid.create.ts';

export type BitcoinLiquidCreationState = {
  stage: 'vaults' | 'form' | 'creating' | 'complete';
  sources: IBitcoinLiquidSource[];
  selectedVaultIds: number[];
  preview?: IBitcoinLiquidCreatePreview;
  isSubmitting: boolean;
  progressPct: number;
  progressLabel: string;
  errorMessage: string;
  treasuryCertificationRequiredSatoshis: bigint;
};
