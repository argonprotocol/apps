import { fn } from 'storybook/test';
import type * as Attention from '../attention.ts';

export const useAttention = fn<typeof Attention.useAttention>();
export const openStabilizerBuyNotice = fn<typeof Attention.openStabilizerBuyNotice>();
