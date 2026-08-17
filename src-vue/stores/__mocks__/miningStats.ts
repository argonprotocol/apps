import { fn } from 'storybook/test';
import type { useMiningStats as useMiningStatsOriginal } from '../miningStats.ts';

export const useMiningStats = fn<typeof useMiningStatsOriginal>();
