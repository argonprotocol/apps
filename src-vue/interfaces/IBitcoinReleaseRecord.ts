export enum BitcoinReleaseKind {
  Lock = 'Lock',
  Orphan = 'Orphan',
}

export enum BitcoinReleaseStatus {
  SubmittingRequestOnArgon = 'SubmittingRequestOnArgon',
  WaitingForVaultCosign = 'WaitingForVaultCosign',
  ReadyForBitcoinBroadcast = 'ReadyForBitcoinBroadcast',
  ConfirmingOnBitcoin = 'ConfirmingOnBitcoin',
  WaitingForArgonRecognition = 'WaitingForArgonRecognition',
  Complete = 'Complete',
  Cancelled = 'Cancelled',
  Failed = 'Failed',
  FailedAcknowledged = 'FailedAcknowledged',
}

export interface IBitcoinReleaseRecord {
  id: string;
  kind: BitcoinReleaseKind;
  lockId: number;
  sendId: string;
  releaseNumber?: number;
  status: BitcoinReleaseStatus;
  inputUtxoIds: number[];
  requestedReleaseAtTick?: number;
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
  destinationSatoshis: bigint;
  changeSatoshis: bigint;
  cosignDueFrame?: number;
  expectedTransactionId?: string;
  insuredMicrogons?: bigint;
  argonTxFeeMicrogons?: bigint;
  compensationMicrogons?: bigint;
  vaultSignatures: Uint8Array[];
  cosignBlockNumber?: number;
  bitcoinTxid?: string;
  bitcoinFirstSeenAt?: Date;
  bitcoinFirstSeenHeight?: number;
  bitcoinFirstSeenOracleHeight?: number;
  bitcoinLastConfirmationCheckAt?: Date;
  bitcoinLastConfirmationCheckOracleHeight?: number;
  bitcoinConfirmedHeight?: number;
  argonCompletionBlockNumber?: number;
  argonCompletionBlockHash?: string;
  argonCompletionBlockTime?: Date;
  argonCompletionExtrinsicIndex?: number;
  statusError?: string;
  createdAt: Date;
  updatedAt: Date;
}
