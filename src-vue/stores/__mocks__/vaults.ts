import { fn } from 'storybook/test';
import type { getMyVault as getMyVaultOriginal, getVaults as getVaultsOriginal } from '../vaults.ts';

export const getVaults = fn<typeof getVaultsOriginal>();
export const getMyVault = fn<typeof getMyVaultOriginal>();
