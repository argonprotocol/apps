import { fn } from 'storybook/test';
import type { getConfig as getConfigOriginal } from '../config.ts';

export const getConfig = fn<typeof getConfigOriginal>();
