import { fn } from 'storybook/test';
import type { useVaultingStats as useVaultingStatsOriginal } from '../vaultingStats.ts';

export const useVaultingStats = fn<typeof useVaultingStatsOriginal>();
