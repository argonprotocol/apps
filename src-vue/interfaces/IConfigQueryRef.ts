import type { IConfig } from './IConfig.ts';

export interface IConfigQueryRef
  extends Pick<
    IConfig,
    | 'miningSetupStatus'
    | 'vaultingSetupStatus'
    | 'biddingRules'
    | 'vaultSetup'
    | 'serverAdd'
    | 'upstreamOperator'
    | 'hasExtensionTreasury'
    | 'hasExtensionOperations'
  > {
  showWelcomeOverlay: boolean;
  hasSavedBiddingRules: boolean;
  hasSavedVaultSetup: boolean;
  isServerAdded: boolean;
  isBootingUpPreviousWalletHistory: boolean;
  save(): Promise<void>;
}
