import { fn } from 'storybook/test';
import type { getCurrency as getCurrencyOriginal } from '../currency.ts';

export const getCurrency = fn<typeof getCurrencyOriginal>();
