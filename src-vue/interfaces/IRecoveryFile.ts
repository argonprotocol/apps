import { IConfig } from './IConfig.ts';
import ISecurity from './ISecurity.ts';

export type IRecoveryFile = Pick<
  IConfig,
  | 'vaultingRules'
  | 'biddingRules'
  | 'serverDetails'
  | 'userJurisdiction'
  | 'oldestFrameIdToSync'
  | 'defaultCurrencyKey'
  | 'requiresPassword'
> & { security: ISecurity };
