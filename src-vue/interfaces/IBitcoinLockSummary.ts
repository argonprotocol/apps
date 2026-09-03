import type { BitcoinLockStatus, IBitcoinLockRecord } from './IBitcoinLockRecord.ts';

export interface IBitcoinLockProcessingDetails {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
  receivedSatoshis?: bigint;
}

export interface IBitcoinLockSummary {
  uuid: string;
  utxoId: number | undefined;
  status: BitcoinLockStatus;
  statusDetails: {
    hasObservedFundingSignal: boolean;
    showReadyForBitcoin: boolean;
    isFundingSeenInMempoolOnly: boolean;
  };
  lockProcessingDetails: IBitcoinLockProcessingDetails;
  lockProcessingError: string;
  satoshis: bigint;
  valueOfBtc: bigint;
  totalLiquidity: bigint;
  pendingLiquidity: bigint;
  receivedLiquidity: bigint;
  valueBeyondLiquidity: bigint;
  startingCapital: bigint;
  endingCapital: bigint;
  ratchetPercent: number;
  totalReturn: number;
  securityFees: bigint;
  transactionFees: bigint;
  totalFees: bigint;
  historicalTransactionFees?: bigint;
  historicalTotalFees?: bigint;
  unlockAmount: bigint;
  createdAt: Date;
  record: IBitcoinLockRecord;
}
