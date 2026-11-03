import { z } from 'zod';

const walletMetadataSchema = z.object({
  miningBotAddress: z.string(),
  vaultingAddress: z.string(),
  operationalAddress: z.string(),
  // Released native wallets predate this public metadata field.
  ethereumAddress: z.string().default(''),
});

export const walletFileSchema = z.object({
  encryptedMnemonic: z.string(),
  protection: z.enum(['none', 'passcode', 'system']).default('none'),
  meta: walletMetadataSchema.optional(),
  pendingKeyChange: z
    .object({
      encryptedMnemonic: z.string(),
      replacements: z.record(z.string(), z.string()),
    })
    .optional(),
});

export type IWalletFile = z.infer<typeof walletFileSchema>;
