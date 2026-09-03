import type { IBitcoinLockRecord } from './IBitcoinLockRecord.ts';
import type { IBitcoinUtxoRecord } from './IBitcoinUtxoRecord.ts';

export interface IBitcoinUnlockReleaseState {
  hasActiveLock: boolean;
  lockStatus?: string;
  isPendingFunding: boolean;
  isLockReadyForUnlock: boolean;
  hasFundingRecord: boolean;
  fundingStatus?: string;
  isReleaseStatus: boolean;
  isArgonSubmitting: boolean;
  isWaitingForVaultCosign: boolean;
  isBitcoinReleaseProcessing: boolean;
  hasRequestDetails: boolean;
  hasCosign: boolean;
  hasReleaseTxid: boolean;
  isReleaseComplete: boolean;
}

export interface IBitcoinVaultUnlockStateDetails {
  activeLocks: Array<{
    lock: IBitcoinLockRecord;
    fundingRecord?: IBitcoinUtxoRecord;
  }>;
}
