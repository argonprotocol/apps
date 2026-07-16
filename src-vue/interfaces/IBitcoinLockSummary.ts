import type { BitcoinLockStatus, IBitcoinLockRecord } from './IBitcoinLockRecord.ts';

export interface IBitcoinLockProcessingDetails {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
  receivedSatoshis?: bigint;
  isInvalidAmount?: boolean;
}

export interface IBitcoinLockSummary {
  uuid: string;
  utxoId: number | undefined;
  status: BitcoinLockStatus;
  statusDetails: {
    hasObservedFundingSignal: boolean;
    showMismatchAccept: boolean;
    showFundingMismatch: boolean;
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
  hodlingReturn: number;
  totalReturn: number;
  totalFees: bigint;
  unlockAmount: bigint;
  createdAt: Date;
  record: IBitcoinLockRecord;
}
