import type { IBitcoinLock } from '@argonprotocol/mainchain';
import type { BitcoinLockRelayStatus } from '@argonprotocol/apps-router';
import type { IBitcoinUtxoRecord } from './IBitcoinUtxoRecord.ts';

export interface IRatchet {
  mintAmount: bigint;
  mintPending: bigint;
  lockedTargetPrice: bigint;
  securityFee: bigint;
  txFee: bigint;
  burned: bigint;
  blockHeight: number;
  oracleBitcoinBlockHeight: number;
}

export interface IBitcoinLockRelayMetadata {
  operatorHost?: string;
  offerCode: string;
  status: BitcoinLockRelayStatus;
  error?: string;
  expiresAtBlockHeight?: number;
}

export interface IBitcoinLockBlockExtrinsicError {
  batchInterruptedIndex?: number;
  errorCode?: string;
  details?: string;
  message: string;
}

export enum BitcoinLockStatus {
  LockIsProcessingOnArgon = 'LockIsProcessingOnArgon', // Submitted transaction to the Argon chain but not yet confirmed in block.
  LockPendingFunding = 'LockPendingFunding', // Argon lock exists and vault securitization is reserved; waiting for Bitcoin funding confirmation/candidate resolution.
  LockExpiredWaitingForFunding = 'LockExpiredWaitingForFunding', // Lock expired before funding could be verified on Argon.
  LockExpiredWaitingForFundingAcknowledged = 'LockExpiredWaitingForFundingAcknowledged', // User has seen the fresh funding-expired state.
  LockFundingReadyToResume = 'LockFundingReadyToResume', // A mismatch return finished and the user must explicitly resume funding.

  LockedAndIsMinting = 'LockedAndIsMinting', // Bitcoin is fully locked but minting is still settling.
  LockedAndMinted = 'LockedAndMinted', // Bitcoin is fully locked and minting is complete.

  Releasing = 'Releasing', // Release lifecycle is in progress (argon request, vault cosign, signing, or bitcoin broadcast).
  Released = 'Released', // Release lifecycle is complete.

  LockFailed = 'LockFailed', // The Argon request to initialize this lock failed before a UTXO was created.
}

export interface IBitcoinLockRecord {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  satoshis: bigint;
  liquidityPromised: bigint;
  lockedMarketRate: bigint;
  ratchets: IRatchet[];
  cosignVersion: string;
  lockDetails: IBitcoinLock;
  fundingUtxoRecordId: number | null;
  fundingUtxoRecord?: IBitcoinUtxoRecord;
  network: string;
  hdPath: string;
  vaultId: number;
  relayMetadataJson?: IBitcoinLockRelayMetadata | null;
  blockExtrinsicErrorJson?: IBitcoinLockBlockExtrinsicError | null;
  createdAt: Date;
  updatedAt: Date;
}
