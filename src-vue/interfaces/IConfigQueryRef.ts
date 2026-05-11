import type { IConfig } from './IConfig.ts';

export interface IConfigQueryRef
  extends Pick<IConfig, 'miningSetupStatus' | 'vaultingSetupStatus' | 'biddingRules' | 'vaultingRules' | 'serverAdd'> {
  showWelcomeOverlay: boolean;
  hasSavedBiddingRules: boolean;
  hasSavedVaultingRules: boolean;
}
