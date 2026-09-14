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

export enum BitcoinUtxoStatus {
  SeenOnMempool = 'SeenOnMempool', // Found on Bitcoin before the current runtime classifies it as funding or orphaned.
  FundingUtxo = 'FundingUtxo', // Accepted funding UTXO backing this lock.
  Orphaned = 'Orphaned', // Non-accepted deposit that has moved into the return path.
}

export enum BitcoinUtxoSpendStatus {
  Unspent = 'Unspent',
  Spent = 'Spent',
}

export interface IBitcoinUtxoRecord {
  id: number;
  lockId: number;
  txid: string;
  vout: number;
  satoshis: bigint;
  network: string;
  status: BitcoinUtxoStatus;
  spendStatus: BitcoinUtxoSpendStatus;
  activeReleaseId?: string;
  createdByReleaseId?: string;
  spentByReleaseId?: string;
  statusError?: string;
  mempoolObservation?: IMempoolFundingObservation;
  firstSeenAt: Date;
  firstSeenOnArgonAt?: Date;
  firstSeenBitcoinHeight: number;
  firstSeenOracleHeight?: number;
  lastConfirmationCheckAt?: Date;
  lastConfirmationCheckOracleHeight?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinUtxoStatusHistoryRecord {
  id: number;
  utxoRecordId: number;
  newStatus: BitcoinUtxoStatus;
  createdAt: Date;
}
