import type { IConfig } from './IConfig.ts';

export interface IConfigQueryRef
  extends Pick<
    IConfig,
    'miningSetupStatus' | 'vaultingSetupStatus' | 'biddingRules' | 'vaultingRules' | 'serverAdd' | 'upstreamOperator'
  > {
  showWelcomeOverlay: boolean;
  hasSavedBiddingRules: boolean;
  hasSavedVaultingRules: boolean;
  isServerAdded: boolean;
}
