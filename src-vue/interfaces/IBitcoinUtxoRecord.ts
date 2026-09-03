export interface IMempoolFundingObservation {
  isConfirmed: boolean;
  confirmations: number;
  satoshis: bigint;
  txid?: string;
  vout?: number;
  transactionBlockHeight: number;
  transactionBlockTime: number;
  argonBitcoinHeight: number;
}

export enum BitcoinUtxoRole {
  Funding = 'Funding',
  Orphan = 'Orphan',
}

export enum BitcoinUtxoStatus {
  SeenOnMempool = 'SeenOnMempool', // Found on Bitcoin before the current runtime classifies it as funding or orphaned.
  FundingUtxo = 'FundingUtxo', // Accepted funding UTXO backing this lock.
  Orphaned = 'Orphaned', // Non-accepted deposit that has moved into the return path.
  ReleaseIsProcessingOnArgon = 'ReleaseIsProcessingOnArgon', // Release request submitted to Argon and still in pre-Bitcoin finalization phases.
  ReleaseIsProcessingOnBitcoin = 'ReleaseIsProcessingOnBitcoin', // Release transaction was observed on Bitcoin and is being confirmed.
  ReleaseComplete = 'ReleaseComplete', // Release is fully complete.
  ReleaseCompleteAcknowledged = 'ReleaseCompleteAcknowledged', // Release completed and the lock has already handled the result.
}

export interface IBitcoinUtxoRecord {
  id: number;
  lockUtxoId: number;
  txid: string;
  vout: number;
  satoshis: bigint;
  network: string;
  role?: BitcoinUtxoRole;
  status: BitcoinUtxoStatus;
  statusError?: string;
  mempoolObservation?: IMempoolFundingObservation;
  firstSeenAt: Date;
  firstSeenOnArgonAt?: Date;
  firstSeenBitcoinHeight: number;
  firstSeenOracleHeight?: number;
  lastConfirmationCheckAt?: Date;
  lastConfirmationCheckOracleHeight?: number;
  requestedReleaseAtTick?: number;
  releaseBitcoinNetworkFee?: bigint;
  releaseToDestinationAddress?: string;
  releaseCosignVaultSignature?: Uint8Array;
  releaseCosignHeight?: number;
  releaseTxid?: string;
  releaseFirstSeenAt?: Date;
  releaseFirstSeenBitcoinHeight?: number;
  releaseFirstSeenOracleHeight?: number;
  releaseLastConfirmationCheckAt?: Date;
  releaseLastConfirmationCheckOracleHeight?: number;
  releasedAtBitcoinHeight?: number;
  createdAt: Date;
  updatedAt: Date;
}

export type IConfirmedReleaseCosign = {
  releaseCosignVaultSignature: Uint8Array;
  releaseCosignHeight: number;
};

export interface IBitcoinUtxoStatusHistoryRecord {
  id: number;
  utxoRecordId: number;
  newStatus: BitcoinUtxoStatus;
  createdAt: Date;
}
