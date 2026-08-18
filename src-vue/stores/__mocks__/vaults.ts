import { fn } from 'storybook/test';
import type {
  getCrosschainHistory as getCrosschainHistoryOriginal,
  getKnownCrosschainSourceIdentities as getKnownCrosschainSourceIdentitiesOriginal,
  getMyVault as getMyVaultOriginal,
  getVaults as getVaultsOriginal,
} from '../vaults.ts';

export const getVaults = fn<typeof getVaultsOriginal>();
export const getMyVault = fn<typeof getMyVaultOriginal>();
export const getCrosschainHistory = fn<typeof getCrosschainHistoryOriginal>();
export const getKnownCrosschainSourceIdentities = fn<typeof getKnownCrosschainSourceIdentitiesOriginal>();
