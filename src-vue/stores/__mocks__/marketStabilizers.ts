import { fn } from 'storybook/test';
import type * as MarketStabilizers from '../marketStabilizers.ts';

export const useMarketStabilizers = fn<typeof MarketStabilizers.useMarketStabilizers>();
