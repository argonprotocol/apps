import type { IBitcoinLockDetails } from '@argonprotocol/apps-core';

export type IBitcoinLockScriptDetails = Pick<
  IBitcoinLockDetails,
  | 'p2wshScriptHashHex'
  | 'vaultPubkey'
  | 'vaultClaimPubkey'
  | 'ownerPubkey'
  | 'vaultXpubSources'
  | 'vaultClaimHeight'
  | 'openClaimHeight'
  | 'createdAtHeight'
>;

export interface IBitcoinLockBlockExtrinsicError {
  batchInterruptedIndex?: number;
  errorCode?: string;
  details?: string;
  message: string;
}

export enum BitcoinLockStatus {
  LockIsProcessingOnArgon = 'LockIsProcessingOnArgon', // Submitted transaction to the Argon chain but not yet confirmed in block.
  LockPendingFunding = 'LockPendingFunding', // Argon lock exists and vault securitization is reserved; waiting for Bitcoin funding confirmation.
  LockFailedAcknowledged = 'LockFailedAcknowledged', // User has acknowledged the failed Argon-side lock request.

  LockFunded = 'LockFunded', // The Lock has at least one accepted Bitcoin funding UTXO.
  Releasing = 'Releasing', // The Lock has an active outbound release workflow.
  Released = 'Released', // Release lifecycle is complete.

  LockFailed = 'LockFailed', // The Argon request to initialize this lock failed before a UTXO was created.
}

export interface IBitcoinLockRecord {
  uuid: string;
  lockId?: number;
  status: BitcoinLockStatus;
  securitizedSatoshis: bigint;
  fundedSatoshis: bigint;
  fundingUtxoIds: number[];
  activeReleaseId?: string;
  ownerAccount?: string;
  microgonsAtTargetPerBtc?: bigint;
  securitizationCoverageMicrogons?: bigint;
  securitizationTick?: number;
  fissionedSatoshis?: bigint;
  securitizationRatio?: number;
  securityFees: bigint;
  couponFeesPaid: bigint;
  scriptDetails?: IBitcoinLockScriptDetails;
  securitizationHoldExpirationBitcoinHeight?: number;
  isFlexible?: boolean;
  fundHoldExtensionsByBitcoinExpirationHeight: Record<number, bigint>;
  createdAtArgonBlock?: number;

  cosignVersion: string;
  network: string;
  hdPath: string;
  vaultId: number;
  blockExtrinsicErrorJson?: IBitcoinLockBlockExtrinsicError | null;
  removalBlockNumber?: number;
  removalBlockHash?: string;
  removalBlockTime?: Date;
  removalExtrinsicIndex?: number;
  removalReason?: 'released' | 'spent' | 'expired';
  btcPriceAtRemovalMicrogons?: bigint;
  isHistoryRecoveryPending?: boolean;
  createdAt: Date;
  updatedAt: Date;
}
