export type BitcoinLockRelayStatus =
  | 'Queued'
  | 'WaitingForCapacity'
  | 'Submitting'
  | 'Submitted'
  | 'InBlock'
  | 'Finalized'
  | 'Failed';

export interface IBitcoinLockRelayRequest {
  offerToken: string;
  requestedSatoshis: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc?: bigint;
}

export interface IBitcoinLockRelayJobRequest {
  routerInviteId: number;
  offerCode: string;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
}

export interface IBitcoinLockRelayLock {
  utxoId: number;
  vaultId: number;
  ownerAccountAddress: string;
  satoshis: bigint;
  liquidityPromised: bigint;
  lockedMarketRate: bigint;
  securityFees: bigint;
  createdAtHeight: number;
  lockDetailsJson?: any;
}

export interface IBitcoinLockRelay {
  id: number;
  status: BitcoinLockRelayStatus;
  queueReason?: string;
  error?: string;
  delegateAddress?: string;
  extrinsicHash?: string;
  extrinsicMethodJson?: any;
  nonce?: number;
  submittedAtBlockHeight?: number;
  submittedAtTime?: Date;
  finalizedHeight?: number;
  txFeePlusTip?: bigint;
  utxoId?: number;
  createdLock?: IBitcoinLockRelayLock;
}

export interface IBitcoinLockRelayRecord extends IBitcoinLockRelay {
  routerInviteId: number;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  reservedSatoshis: bigint;
  reservedLiquidityMicrogons: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
  inBlockHeight?: number;
  txTip?: bigint;
  createdAt: Date;
  updatedAt: Date;
}
