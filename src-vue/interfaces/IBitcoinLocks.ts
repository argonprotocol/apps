import type { IBitcoinLockRecord } from './IBitcoinLockRecord.ts';
import type { IBitcoinUtxoRecord } from './IBitcoinUtxoRecord.ts';
import type { ITransactionRecord } from './ITransactionRecord.ts';

export interface IBitcoinLockQueryRecord {
  uuid: string;
  utxoId?: number;
  status?: string;
}

export interface IBitcoinVaultMismatchState {
  hasActiveLock: boolean;
  lockStatus?: string;
  phase: string;
  isPendingFunding: boolean;
  isFundingReadyToResume: boolean;
  isPostFundingLock: boolean;
  candidateCount: number;
  hasError: boolean;
  hasNextCandidate: boolean;
  nextCandidateCanAccept: boolean;
  nextCandidateCanReturn: boolean;
}

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
    latestAcceptTx?: ITransactionRecord;
    fundingCandidates: IBitcoinUtxoRecord[];
  }>;
}

export interface IBitcoinLocksQueryRef {
  load(force?: boolean): Promise<void>;
  getActiveLocks(): IBitcoinLockQueryRecord[];
  getLockMismatchState(lock: IBitcoinLockQueryRecord | undefined): IBitcoinVaultMismatchState;
  getLockSatoshiAllowedVariance(): number | undefined;
  getLockUnlockReleaseState(lock: IBitcoinLockQueryRecord | undefined): IBitcoinUnlockReleaseState;
  getVaultUnlockStateDetails(vaultId: number): IBitcoinVaultUnlockStateDetails;
}
