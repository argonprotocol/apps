import { z } from 'zod';

export const VaultingRulesSchema = z.object({
  capitalForSecuritizationPct: z.number(),
  capitalForTreasuryPct: z.number(),

  securitizationRatio: z.number(),
  profitSharingPct: z.number(),
  btcFlatFee: z.bigint(),
  btcPctFee: z.number(),
  personalBtcPct: z.number(),

  btcUtilizationPctMin: z.number().min(0).max(100),
  btcUtilizationPctMax: z.number().min(0).max(100),

  poolUtilizationPctMin: z.number().min(0).max(100),
  poolUtilizationPctMax: z.number().min(0).max(100),

  // TODO: rename to committedMicrogons
  baseMicrogonCommitment: z.bigint(),
  baseMicronotCommitment: z.bigint(),
});

export type IVaultingRules = z.infer<typeof VaultingRulesSchema>;

export default IVaultingRules;
