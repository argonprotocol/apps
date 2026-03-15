export interface IBitcoinVaultMismatchState {
  hasActiveLock: boolean;
  lockStatus?: string;
  isPendingFunding: boolean;
  isFundingReadyToResume: boolean;
  isPostFundingLock: boolean;
  mismatchRequired: boolean;
  canActOnMismatch: boolean;
  hasMismatchAcceptInProgress: boolean;
  hasOrphanedReturnInProgress: boolean;
  candidateCount: number;
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
    lock: {
      uuid: string;
      utxoId?: number;
      status?: string;
    };
    fundingRecord?: {
      status?: string;
      txid?: string | null;
      releaseTxid?: string | null;
      releaseToDestinationAddress?: string | null;
      releaseCosignVaultSignature?: string | null;
    };
    latestAcceptTx?: {
      status?: string;
    };
    fundingCandidates: Array<{
      id?: number;
      status?: string;
      satoshis?: bigint;
    }>;
  }>;
}

export interface IBitcoinLocksMismatchInspect {
  load(): Promise<unknown>;
  getVaultMismatchState(vaultId: number): IBitcoinVaultMismatchState;
}

export interface IBitcoinLocksUnlockReleaseInspect {
  load(): Promise<unknown>;
  getVaultUnlockReleaseState(vaultId: number): IBitcoinUnlockReleaseState;
}

export interface IBitcoinLocksUnlockDetailsInspect {
  load(): Promise<unknown>;
  getVaultUnlockStateDetails(vaultId: number): IBitcoinVaultUnlockStateDetails;
}

export interface IBitcoinLocksVarianceInspect {
  load(): Promise<unknown>;
  getLockSatoshiAllowedVariance(): number | undefined;
}

export interface IMyVaultInspect {
  load(): Promise<unknown>;
  vaultId?: number;
}

export interface IConfig {
  hasReadVaultingInstructions?: boolean;
  hasSavedVaultingRules?: boolean;
}

export type Config = IConfig;
