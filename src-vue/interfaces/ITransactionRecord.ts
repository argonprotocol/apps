export enum ExtrinsicType {
  VaultCreate = 'VaultCreate',
  VaultModifySettings = 'VaultModifySettings',
  VaultInitialAllocate = 'VaultInitialAllocate',
  VaultIncreaseAllocation = 'VaultIncreaseAllocation',
  VaultCollect = 'VaultCollect',
  VaultSetCommittedArgonots = 'VaultSetCommittedArgonots',
  VaultSetBitcoinLockDelegate = 'VaultSetBitcoinLockDelegate',
  VaultTopUpBitcoinLockDelegate = 'VaultTopUpBitcoinLockDelegate',
  OperationalActivateAndClaim = 'OperationalActivateAndClaim',
  OperationalClaimRewards = 'OperationalClaimRewards',

  BitcoinRequestLock = 'BitcoinRequestLock', // LockIsProcessingOnArgon
  BitcoinRequestRelease = 'BitcoinRequestRelease', // funding UTXO enters release lifecycle on Argon
  VaultCosignBitcoinRelease = 'VaultCosignBitcoinRelease', // vault cosigns release request before bitcoin broadcast
  VaultCosignOrphanedUtxoRelease = 'VaultCosignOrphanedUtxoRelease',
  BitcoinOrphanedUtxoUseAsFunding = 'BitcoinOrphanedUtxoUseAsFunding',
  BitcoinOrphanedUtxoRelease = 'BitcoinOrphanedUtxoRelease',

  Transfer = 'Transfer',
  CrosschainTransferProve = 'CrosschainTransferProve',
  CrosschainTransferTransferOut = 'CrosschainTransferTransferOut',
  CrosschainTransferApproveCouncil = 'CrosschainTransferApproveCouncil',
  CrosschainTransferAuthorize = 'CrosschainTransferAuthorize',
  CrosschainTransferRegisterMintingAuthority = 'CrosschainTransferRegisterMintingAuthority',

  TreasuryBuyBonds = 'TreasuryBuyBonds',
  TreasuryReleaseBondLot = 'TreasuryReleaseBondLot',
}

export enum TransactionStatus {
  Submitted = 'Submitted',
  InBlock = 'InBlock',
  Finalized = 'Finalized',
  Error = 'Error',
  TimedOutWaitingForBlock = 'TimedOutWaitingForBlock',
}

export interface ITransactionRecord<MetadataType = any> {
  id: number; // Auto-incrementing primary key since extrinsic hash isn't implicitly unique and can overlap
  status: TransactionStatus;
  followOnTxId?: number;
  extrinsicHash: string;
  extrinsicMethodJson: any;
  extrinsicType: ExtrinsicType;
  metadataJson: MetadataType;
  accountAddress: string;
  submittedAtTime: Date;
  submittedAtBlockHeight: number;
  submissionErrorJson: any;
  txNonce?: number;
  txTip: bigint | undefined;
  txFeePlusTip: bigint | undefined;
  blockHeight: number | undefined;
  blockHash: string | undefined;
  blockTime: Date | undefined;
  blockExtrinsicIndex: number | undefined;
  blockExtrinsicEventsJson: any[];
  blockExtrinsicErrorJson:
    | { batchInterruptedIndex?: number; errorCode?: string; details?: string; message: string }
    | undefined;
  finalizedHeadHeight: number | undefined;
  finalizedHeadTime: Date | undefined;
  isFinalized: boolean;
  createdAt: Date;
  updatedAt: Date;
}
